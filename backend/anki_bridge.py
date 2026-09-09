import contextlib
import json
import os
import sys
import threading
from pathlib import Path

from anki.collection import Collection
from anki.errors import NotFoundError
from anki.sync_pb2 import SyncCollectionResponse, SyncStatusResponse

from anki_bridge_decks import (
    create_deck, create_deck_config, deck_config_detail, deck_configs, delete_deck,
    delete_deck_config, rename_deck, required_deck_config, set_deck_config, update_deck_config,
)
from anki_bridge_models import (
    add_model_field, add_model_template, create_model, delete_model, delete_model_field,
    delete_model_template, model_info, model_infos, update_model, update_model_field,
    update_model_template,
)
from anki_bridge_notes import (
    add_note, batch_card_action, browser_note_info, browser_note_preview, card_info, copy_notes,
    create_browser_note, find_and_replace, note_info, placeholder, search_note_rows, search_notes,
)

# Anki's Rust backend logs to stdout (for example "blocked main thread for 1305ms"),
# so the result must be marked to stay readable next to that noise.
RESULT_PREFIX = "__ANKI_BRIDGE_RESULT__"
# A blocking sync reports nothing until it is done, so a watcher thread polls Anki's own progress state
# and writes it on its own marker. The client ignores these lines unless it asked for them.
PROGRESS_PREFIX = "__ANKI_BRIDGE_PROGRESS__"
PROGRESS_INTERVAL = 0.2
# Every field of anki.collection_pb2.Progress.Value that a sync can be in. Anki reports one value
# at a time, so an absent field means "this kind of work is not running".
PROGRESS_KINDS = ("normal_sync", "full_sync", "media_sync")


def env_list(name, fallback):
    items = [item.strip() for item in os.environ.get(name, "").split(",") if item.strip()]
    return items or fallback


# A fresh collection's default note type. Its name and its fields are neutral on purpose, because the app
# assumes no language; an install whose note type is written another way points CARO_NOTE_FIELDS at its own
# field names.
DEFAULT_NOTE_TYPE = "Caro"
# The name this app gave that note type while it assumed an English card. Nothing creates it anymore; it is
# read only to tell a configured collection from a fresh one, so an install that already has a default is
# never handed a second, empty note type. Keep the spelling resolvable.
LEGACY_DEFAULT_NOTE_TYPES = ("English",)
NOTE_FIELDS = env_list("CARO_NOTE_FIELDS", ["Front", "Back", "Notes"])
AUTO_BACKUP_ACTIONS = {
    "createDeck", "renameDeck", "deleteDeck", "createDeckConfig", "updateDeckConfig",
    "deleteDeckConfig", "setDeckConfig", "createModel", "updateModel", "deleteModel",
    "addModelField", "updateModelField", "deleteModelField", "addModelTemplate",
    "updateModelTemplate", "deleteModelTemplate", "addTags", "removeTags", "renameTag",
    "deleteTag", "clearUnusedTags", "changeDeck", "setDueDate", "setUserFlag",
    "changeDeckForNotes", "setDueDateForNotes", "setUserFlagForNotes", "copyNotes",
    "findAndReplace", "updateNoteFields", "addNote", "createBrowserNote", "addNotes",
    "deleteNotes", "undo", "redo",
}


def emit(payload):
    print(RESULT_PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)


def read_progress(col):
    # Anki fills exactly one Progress value at a time and formats the counts itself, so what arrives is
    # Anki's own vocabulary ("Added/modified: 2↑ 1↓"); only a full sync carries real bytes, because a
    # merge sends change chunks. Polling is advisory, so a failure here must never reach the sync it is
    # watching — least of all while a full sync has the collection closed.
    try:
        progress = col._backend.latest_progress()
    except Exception:
        return None
    kind = progress.WhichOneof("value") if progress is not None else None
    if kind not in PROGRESS_KINDS:
        return None
    value = getattr(progress, kind)
    if kind == "normal_sync":
        return {"kind": kind, "stage": value.stage or None,
                "added": value.added or None, "removed": value.removed or None}
    if kind == "full_sync":
        return {"kind": kind, "transferred": int(value.transferred), "total": int(value.total)}
    return {"kind": kind, "media": {
        "checked": value.checked or None, "added": value.added or None, "removed": value.removed or None}}


class ProgressWatcher:
    # A sync blocks until it returns, so the only way to report it is from another thread. Each distinct
    # state is written once, and the last one is kept because a finished sync clears Anki's progress
    # before the caller reads the result.
    def __init__(self, col):
        self.col = col
        # `emitted` is what has already been written out, so an unchanged state is not repeated; `last` is
        # what this sync reports as its outcome.
        self.emitted = None
        self.last = None
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.wait(PROGRESS_INTERVAL):
            progress = read_progress(self.col)
            if progress is None or progress == self.emitted:
                continue
            self.emitted = progress
            # Anki runs the media sync on a thread of its own after the collection sync has already
            # returned, so a media state outlives this call and can even belong to an earlier run: only the
            # collection's own state describes the sync that just finished.
            if progress["kind"] != "media_sync":
                self.last = progress
            print(PROGRESS_PREFIX + json.dumps(progress, ensure_ascii=False), flush=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *error):
        self.stop.set()
        self.thread.join(timeout=2)
        return False


def ensure_default_note_type(col):
    if any(col.models.by_name(name) for name in (DEFAULT_NOTE_TYPE,) + LEGACY_DEFAULT_NOTE_TYPES):
        return
    model = col.models.new(DEFAULT_NOTE_TYPE)
    for name in NOTE_FIELDS:
        col.models.add_field(model, col.models.new_field(name))
    template = col.models.new_template("Card 1")
    template["qfmt"] = placeholder(NOTE_FIELDS[0])
    afmt = placeholder("FrontSide") + "<hr id=answer>" + placeholder(NOTE_FIELDS[min(1, len(NOTE_FIELDS) - 1)])
    if len(NOTE_FIELDS) > 2:
        afmt += "<br>" + placeholder(NOTE_FIELDS[2])
    template["afmt"] = afmt
    col.models.add_template(model, template)
    col.models.add(model)


def login(col, params):
    auth = col.sync_login(params["username"], params["password"], params.get("endpoint") or None)
    return {"newEndpoint": auth.endpoint or None}


def sync_stamps(col):
    # Anki stamps the collection at every write (mod), at every schema change (scm), and remembers the
    # stamp of its last successful sync (ls). Those three are the whole local half of Anki's sync check
    # (Collection.sync_status_offline), which the pylib does not expose.
    mod, scm, last_sync = col.db.first("select mod, scm, ls from col")
    return {"mod": mod, "scm": scm, "lastSync": last_sync}


def undo_status(col):
    # `UndoStatus.undo`/`.redo` are Anki's own human-readable names for the next undoable/redoable
    # operation ("Update Note", "Remove Note", ...), or an empty string when there is nothing to do.
    status = col.undo_status()
    return {"undo": status.undo or None, "redo": status.redo or None}


def sync_check(col, params):
    # The server half is delegated to Anki itself rather than re-implemented: sync_status() answers from
    # the local stamps first, only then compares AnkiWeb's meta, and caches that answer for 300s.
    auth = col.sync_login(params["username"], params["password"], params.get("endpoint") or None)
    status = col.sync_status(auth)
    return {
        "required": SyncStatusResponse.Required.Name(status.required),
        "newEndpoint": status.new_endpoint or None,
    }


def backup_folder(col):
    folder = Path(col.path).parent / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    return str(folder)


def create_backup(col, force):
    return col.create_backup(
        backup_folder=backup_folder(col), force=force, wait_for_completion=True)


def backup_settings(col):
    settings = col.get_preferences().backups
    return {
        "daily": int(settings.daily),
        "weekly": int(settings.weekly),
        "monthly": int(settings.monthly),
        "minimumIntervalMins": int(settings.minimum_interval_mins),
    }


def update_backup_settings(col, params):
    values = {
        "daily": params["daily"],
        "weekly": params["weekly"],
        "monthly": params["monthly"],
        "minimum_interval_mins": params["minimumIntervalMins"],
    }
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in values.values()):
        raise ValueError("Backup settings must be non-negative integers")
    preferences = col.get_preferences()
    for name, value in values.items():
        setattr(preferences.backups, name, value)
    col.set_preferences(preferences)
    return backup_settings(col)



def invoke_action(col, action, params):
    if action == "deckNames":
        return [deck.name for deck in col.decks.all_names_and_ids()]
    if action == "createDeck":
        return create_deck(col, params)
    if action == "renameDeck":
        return rename_deck(col, params)
    if action == "deleteDeck":
        return delete_deck(col, params)
    if action == "deckConfigs":
        return deck_configs(col)
    if action == "deckConfig":
        return deck_config_detail(col, required_deck_config(col, params["configId"]))
    if action == "createDeckConfig":
        return create_deck_config(col, params)
    if action == "updateDeckConfig":
        return update_deck_config(col, params)
    if action == "deleteDeckConfig":
        return delete_deck_config(col, params)
    if action == "setDeckConfig":
        return set_deck_config(col, params)
    if action == "modelNames":
        return [model.name for model in col.models.all_names_and_ids()]
    if action == "modelInfos":
        return model_infos(col)
    if action == "modelInfo":
        return model_info(col, params["modelName"])
    if action == "createModel":
        return create_model(col, params)
    if action == "updateModel":
        return update_model(col, params)
    if action == "deleteModel":
        return delete_model(col, params)
    if action == "addModelField":
        return add_model_field(col, params)
    if action == "updateModelField":
        return update_model_field(col, params)
    if action == "deleteModelField":
        return delete_model_field(col, params)
    if action == "addModelTemplate":
        return add_model_template(col, params)
    if action == "updateModelTemplate":
        return update_model_template(col, params)
    if action == "deleteModelTemplate":
        return delete_model_template(col, params)
    if action == "currentDeckName":
        return col.decks.current()["name"]
    if action == "modelFieldNames":
        model = col.models.by_name(params["modelName"])
        if not model:
            raise ValueError(f'Note type not found: {params["modelName"]}')
        return [field["name"] for field in model["flds"]]
    if action == "modelNamesAndIds":
        return {model.name: int(model.id) for model in col.models.all_names_and_ids()}
    if action == "findModelsById":
        models = [col.models.get(model_id) for model_id in params["modelIds"]]
        return [{"name": model["name"], "sortf": model["sortf"]} for model in models if model]
    if action == "findNotes":
        return [int(note_id) for note_id in col.find_notes(params["query"])]
    if action == "searchNotes":
        return search_notes(col, params)
    if action == "searchNoteRows":
        return search_note_rows(col, params)
    if action == "browserNoteInfo":
        try:
            return browser_note_info(col, col.get_note(params["noteId"]), params.get("select"))
        except NotFoundError:
            return None
    if action == "browserNotePreview":
        try:
            return browser_note_preview(col, col.get_note(params["noteId"]))
        except NotFoundError:
            return None
    if action == "notesInfo":
        return [info for note_id in params["notes"] if (info := note_info(col, note_id))]
    if action == "cardsInfo":
        return [info for card_id in params["cards"] if (info := card_info(col, card_id))]
    if action == "getTags":
        # Anki returns Tag objects in some versions and plain strings in others.
        return sorted(tag if isinstance(tag, str) else tag.name for tag in col.tags.all())
    if action == "backupSettings":
        return backup_settings(col)
    if action == "updateBackupSettings":
        return update_backup_settings(col, params)
    if action == "createBackup":
        return {"created": create_backup(col, bool(params.get("force")))}
    if action == "checkDatabase":
        report, healthy = col.fix_integrity()
        return {"healthy": healthy, "report": report}
    if action == "checkMedia":
        report = col.media.check()
        return {
            "missing": list(report.missing),
            "unused": list(report.unused),
            "report": report.report,
            "haveTrash": bool(report.have_trash),
        }
    if action == "addTags":
        for note_id in params["notes"]:
            note = col.get_note(note_id)
            note.tags = list(dict.fromkeys([*note.tags, *params["tags"]]))
            col.update_note(note)
        return None
    if action == "removeTags":
        for note_id in params["notes"]:
            note = col.get_note(note_id)
            note.tags = [tag for tag in note.tags if tag not in params["tags"]]
            col.update_note(note)
        return None
    if action == "renameTag":
        col.tags.rename(params["oldName"], params["name"])
        return None
    if action == "deleteTag":
        col.tags.remove(params["name"])
        return None
    if action == "clearUnusedTags":
        return col.tags.clear_unused_tags().count
    if action == "changeDeck":
        col.set_deck(params["cards"], col.decks.id(params["deck"]))
        return None
    if action == "setDueDate":
        col.sched.set_due_date(params["cards"], params["days"])
        return None
    if action == "setUserFlag":
        col.set_user_flag_for_cards(int(params["flag"]), params["cards"])
        return None
    if action == "changeDeckForNotes":
        return batch_card_action(col, params, lambda cards: col.set_deck(cards, col.decks.id(params["deck"])))
    if action == "setDueDateForNotes":
        return batch_card_action(col, params, lambda cards: col.sched.set_due_date(cards, params["days"]))
    if action == "setUserFlagForNotes":
        return batch_card_action(col, params, lambda cards: col.set_user_flag_for_cards(int(params["flag"]), cards))
    if action == "copyNotes":
        return copy_notes(col, params)
    if action == "findAndReplace":
        return find_and_replace(col, params)
    if action == "updateNoteFields":
        note = col.get_note(params["note"]["id"])
        for name, value in params["note"]["fields"].items():
            note[name] = value
        col.update_note(note)
        return None
    if action == "addNote":
        return add_note(col, params["note"])
    if action == "createBrowserNote":
        return create_browser_note(col, params)
    if action == "addNotes":
        return [add_note(col, note) for note in params["notes"]]
    if action == "deleteNotes":
        col.remove_notes(params["notes"])
        return None
    if action == "undoStatus":
        return undo_status(col)
    if action == "undo":
        col.undo()
        return undo_status(col)
    if action == "redo":
        col.redo()
        return undo_status(col)
    if action == "login":
        return login(col, params)
    if action == "syncStamps":
        return sync_stamps(col)
    if action == "syncCheck":
        return sync_check(col, params)
    if action == "sync":
        auth = col.sync_login(params["username"], params["password"], params.get("endpoint") or None)
        # Anki answers NO_CHANGES both when there was nothing to do and after a merge it has just
        # performed, so its answer alone cannot say whether data moved. Finalizing a sync always stamps the
        # collection (finalize_sync writes `ls`), so the sync stamp taken around this call is the local
        # evidence that a merge actually ran.
        before = sync_stamps(col)
        # The watcher is only started when the caller asked for progress, because it polls Anki from a
        # second thread and a caller that cannot show it should not pay for it.
        watcher = ProgressWatcher(col) if params.get("progress") is True else None
        with watcher or contextlib.nullcontext():
            output = col.sync_collection(auth, bool(params.get("syncMedia")))
            required = SyncCollectionResponse.ChangesRequired.Name(output.required)
            direction = params.get("fullSync")
            completed = None
            if direction:
                allowed = ("FULL_SYNC", f"FULL_{direction.upper()}")
                if required not in allowed:
                    raise ValueError(f"Full {direction} is not available after {required}")
                create_backup(col, force=True)
                col.close_for_full_sync()
                try:
                    col.full_upload_or_download(
                        auth=auth, server_usn=output.server_media_usn, upload=direction == "upload")
                    completed = direction
                finally:
                    col.reopen(after_full_sync=True)
        return {
            "required": required,
            "serverMessage": output.server_message,
            "newEndpoint": output.new_endpoint or None,
            "fullSync": completed,
            # A finished sync clears Anki's progress before this line runs, so the last state the watcher
            # saw is the only place the final counts still exist.
            "progress": watcher.last if watcher else None,
            # The collection's stamp before and after, which is what tells a merge apart from a no-op.
            "stamps": {"before": before, "after": sync_stamps(col)},
        }
    raise ValueError(f"Unsupported Anki action: {action}")


def invoke(col, action, params):
    result = invoke_action(col, action, params)
    if action in AUTO_BACKUP_ACTIONS:
        create_backup(col, force=False)
    return result


def main():
    collection_path = Path(sys.argv[1]).expanduser()
    collection_path.parent.mkdir(parents=True, exist_ok=True)
    col = Collection(str(collection_path))
    try:
        ensure_default_note_type(col)
        for line in sys.stdin:
            try:
                request = json.loads(line)
                result = invoke(col, request["action"], request.get("params", {}))
                emit({"result": result, "error": None})
            except Exception as error:
                emit({"result": None, "error": str(error)})
    finally:
        col.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"result": None, "error": str(error)})
        sys.exit(1)
