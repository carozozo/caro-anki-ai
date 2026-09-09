import contextlib
import json
import re
import sys
import threading
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

from anki.collection import Collection
from anki.decks import DEFAULT_DECK_CONF_ID
from anki.errors import NotFoundError
from anki.notes import NoteFieldsCheckResult
from anki.sync_pb2 import SyncCollectionResponse, SyncStatusResponse

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
CARO_FIELDS = [
    "意思", "含意", "字意", "註解", "詞彙", "詞彙US", "詞彙UK", "同義詞",
    "反義詞", "聯想詞", "類型", "類型標籤", "音標", "不規則", "範例",
]


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


def ensure_caro_defaults(col):
    if col.models.by_name("English"):
        return
    model = col.models.new("English")
    for name in CARO_FIELDS:
        col.models.add_field(model, col.models.new_field(name))
    template = col.models.new_template("Card 1")
    template["qfmt"] = "{{詞彙}}"
    template["afmt"] = "{{FrontSide}}<hr id=answer>{{意思}}<br>{{範例}}"
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



def note_data(note):
    model = note.note_type()
    return {
        "noteId": int(note.id),
        "modelName": model["name"],
        "tags": note.tags,
        "fields": {
            name: {"value": value, "order": index}
            for index, (name, value) in enumerate(note.items())
        },
        "cards": [int(card_id) for card_id in note.card_ids()],
    }


def note_info(col, note_id):
    try:
        return note_data(col.get_note(note_id))
    except NotFoundError:
        return None


def card_info(col, card_id):
    try:
        card = col.get_card(card_id)
    except NotFoundError:
        return None
    due_at = None
    if card.queue in (1, 3):
        due_at = datetime.fromtimestamp(card.due, timezone.utc).isoformat()
    elif card.queue == 2:
        due_at = (datetime.now(timezone.utc) + timedelta(days=card.due - col.sched.today)).isoformat()
    return {
        "cardId": int(card.id),
        "deckName": col.decks.name(card.did),
        "dueAt": due_at,
        "flag": int(card.user_flag()),
    }


def new_note(col, payload):
    model = col.models.by_name(payload["modelName"])
    if not model:
        raise ValueError(f'Note type not found: {payload["modelName"]}')
    note = col.new_note(model)
    for name, value in payload["fields"].items():
        note[name] = value
    note.tags = payload.get("tags", [])
    return note


NOTE_INFO_FIELDS = {"modelName", "tags", "fields", "sortField", "preview", "deckName", "dueAt", "flag"}
NOTE_ROW_FIELDS = {"term", "meaning", "modelName", "tags", "deckName", "dueAt", "flag"}


def browser_note_info(col, note, select=None):
    requested = set(select or NOTE_INFO_FIELDS)
    info = {"noteId": int(note.id)}
    model = note.note_type() if requested & {"modelName", "sortField"} else None
    if "modelName" in requested:
        info["modelName"] = model["name"]
    if "tags" in requested:
        info["tags"] = note.tags
    if requested & {"fields", "sortField", "preview"}:
        info["fields"] = {
            name: {"value": value, "order": index}
            for index, (name, value) in enumerate(note.items())
        }
    if "sortField" in requested:
        info["sortFieldIndex"] = model["sortf"]
    if not requested & {"deckName", "dueAt", "flag"}:
        return info
    cards = [card_info(col, card_id) for card_id in note.card_ids()]
    if "deckName" in requested:
        info["deckName"] = next((card["deckName"] for card in cards if card and card["deckName"]), None)
    if "dueAt" in requested:
        due_times = sorted(card["dueAt"] for card in cards if card and card["dueAt"])
        info["dueAt"] = due_times[0] if due_times else None
    if "flag" in requested:
        info["flag"] = next((card["flag"] for card in cards if card and card["flag"]), 0)
    return info


def browser_note_preview(col, note):
    cards = []
    for card_id in note.card_ids():
        card = col.get_card(card_id)
        cards.append({
            "cardId": int(card.id),
            "templateName": card.template()["name"],
            "front": card.question(),
            "back": card.answer(),
        })
    return {"noteId": int(note.id), "modelName": note.note_type()["name"], "cards": cards}


MEANING_FIELD = re.compile(r"^(意思|meaning)$", re.IGNORECASE)
TERM_FIELD = re.compile(r"^(詞彙|term)$", re.IGNORECASE)
SORT_FIELDS = ("term", "meaning", "createdAt", "dueAt")


def query_for_ids(col, sql, note_ids):
    rows = []
    for start in range(0, len(note_ids), 900):
        chunk = note_ids[start:start + 900]
        placeholders = ",".join("?" for _ in chunk)
        rows.extend(col.db.all(sql.format(placeholders=placeholders), *chunk))
    return rows


def field_text(value):
    return display_field_text(value).casefold()


def display_field_text(value):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", re.sub(r"<[^>]*>", " ", value))).strip()


def field_reader(values):
    # A summary row reads three fields of a note type that can hold many, so a packed field is normalized
    # the first time something asks for it and never otherwise. `search_note_rows` pages through hundreds
    # of notes per request, which makes the fields nobody reads the bulk of its work.
    normalized = {}

    def shown(index):
        if index not in normalized:
            normalized[index] = display_field_text(values[index])
        return normalized[index]

    return shown


def named_field(note, pattern):
    return next((field_text(value) for name, value in note.items() if pattern.match(name)), "")


def first_field_text(note):
    return next((text for name, value in note.items() if (text := field_text(value))), "")


def note_term(note):
    fields = list(note.items())
    index = note.note_type()["sortf"]
    sort_field = field_text(fields[index][1]) if 0 <= index < len(fields) else ""
    return named_field(note, TERM_FIELD) or sort_field or first_field_text(note)


def note_meaning(note):
    return named_field(note, MEANING_FIELD)


def note_due_at(col, note):
    cards = [card_info(col, card_id) for card_id in note.card_ids()]
    due_times = sorted(card["dueAt"] for card in cards if card and card["dueAt"])
    return due_times[0] if due_times else ""


def note_sort_value(col, note, field):
    if field == "term":
        return note_term(note)
    if field == "meaning":
        return note_meaning(note)
    if field == "dueAt":
        return note_due_at(col, note)
    return ""


def search_notes(col, params):
    note_ids = [int(note_id) for note_id in col.find_notes(params["query"])]
    field = params["sortField"] if params["sortField"] in SORT_FIELDS else "createdAt"
    reverse = params["sortDirection"] == "desc"
    start = params["skip"]
    stop = None if params["limit"] == 0 else start + params["limit"]
    if field == "createdAt":
        page_ids = sorted(note_ids, reverse=reverse)[start:stop]
        page = [col.get_note(note_id) for note_id in page_ids]
    else:
        keyed = [(note_sort_value(col, note, field), int(note.id), note)
                 for note in (col.get_note(note_id) for note_id in note_ids)]
        present = sorted((item for item in keyed if item[0]),
                         key=lambda item: (item[0], item[1]), reverse=reverse)
        missing = [item for item in keyed if not item[0]]
        page = [item[2] for item in present + missing][start:stop]
    return {"total": len(note_ids), "notes": [browser_note_info(col, note, params.get("select")) for note in page]}


def search_note_rows(col, params):
    started = time.perf_counter()
    note_ids = [int(note_id) for note_id in col.find_notes(params["query"])]
    search_ms = (time.perf_counter() - started) * 1000
    field = params["sortField"] if params["sortField"] in SORT_FIELDS else "createdAt"
    reverse = params["sortDirection"] == "desc"
    skip = max(0, int(params.get("skip", 0)))
    limit = max(0, int(params.get("limit", 0)))
    if field == "createdAt":
        ordered_ids = sorted(note_ids, reverse=reverse)
        page_ids = ordered_ids[skip:None if limit == 0 else skip + limit]
    else:
        ordered_ids = note_ids
        page_ids = note_ids
    requested = set(params.get("select") or NOTE_ROW_FIELDS)
    need_fields = field in ("term", "meaning") or bool(requested & {"term", "meaning"})
    need_model = need_fields or "modelName" in requested
    note_columns = ["id"] + (["mid"] if need_model else []) + (["flds"] if need_fields else []) \
        + (["tags"] if "tags" in requested else [])
    note_started = time.perf_counter()
    raw_notes = query_for_ids(
        col, f"select {', '.join(note_columns)} from notes where id in ({{placeholders}})", page_ids)
    rows = {}
    sort_values = {}
    for values_by_name in (dict(zip(note_columns, values)) for values in raw_notes):
        note_id = values_by_name["id"]
        row = {"noteId": note_id}
        term = meaning = ""
        if need_fields:
            model = col.models.get(values_by_name["mid"])
            fields = values_by_name["flds"].split("\x1f")
            names = [item["name"] for item in model["flds"]]
            shown = field_reader(fields)
            term_index = next((index for index, name in enumerate(names) if TERM_FIELD.match(name)), None)
            meaning_index = next((index for index, name in enumerate(names) if MEANING_FIELD.match(name)), None)
            fallback = shown(model["sortf"]) if model["sortf"] < len(fields) else ""
            term = shown(term_index) if term_index is not None else ""
            term = term or fallback or next((shown(index) for index in range(len(names)) if shown(index)), "")
            meaning = shown(meaning_index) if meaning_index is not None else ""
        elif need_model:
            model = col.models.get(values_by_name["mid"])
        if "modelName" in requested:
            row["modelName"] = model["name"]
        if "term" in requested:
            row["term"] = term
        if "meaning" in requested:
            row["meaning"] = meaning
        if "tags" in requested:
            row["tags"] = values_by_name["tags"].split()
        rows[note_id] = row
        sort_values[note_id] = {"term": term, "meaning": meaning, "dueAt": ""}
    notes_ms = (time.perf_counter() - note_started) * 1000
    card_started = time.perf_counter()
    due_times = {}
    need_cards = field == "dueAt" or bool(requested & {"deckName", "dueAt", "flag"})
    if need_cards:
        now = datetime.now(timezone.utc)
        today = col.sched.today
        raw_cards = query_for_ids(
            col, "select nid, did, due, queue, flags from cards where nid in ({placeholders})", page_ids)
        for note_id, deck_id, due, queue, flags in raw_cards:
            row = rows[note_id]
            if "deckName" in requested and not row.get("deckName"):
                row["deckName"] = col.decks.name(deck_id)
            if "flag" in requested:
                row["flag"] = row.get("flag", 0) or flags & 7
            due_at = None
            if queue in (1, 3):
                due_at = datetime.fromtimestamp(due, timezone.utc).isoformat()
            elif queue == 2:
                due_at = (now + timedelta(days=due - today)).isoformat()
            if due_at:
                due_times[note_id] = min(due_times.get(note_id, due_at), due_at)
        for note_id, due_at in due_times.items():
            sort_values[note_id]["dueAt"] = due_at
            if "dueAt" in requested:
                rows[note_id]["dueAt"] = due_at
        for note_id, row in rows.items():
            if "deckName" in requested:
                row.setdefault("deckName", None)
            if "dueAt" in requested:
                row.setdefault("dueAt", None)
            if "flag" in requested:
                row.setdefault("flag", 0)
    cards_ms = (time.perf_counter() - card_started) * 1000
    sort_started = time.perf_counter()
    if field != "createdAt":
        present = sorted((note_id for note_id in page_ids if sort_values[note_id][field]),
                         key=lambda note_id: (field_text(sort_values[note_id][field]), note_id), reverse=reverse)
        ordered_ids = present + [note_id for note_id in page_ids if not sort_values[note_id][field]]
        page_ids = ordered_ids[skip:None if limit == 0 else skip + limit]
    sort_ms = (time.perf_counter() - sort_started) * 1000
    return {
        "total": len(ordered_ids),
        "notes": [rows[note_id] for note_id in page_ids if note_id in rows],
        **({"noteIds": ordered_ids} if params.get("includeIds") else {}),
        "timing": {"searchMs": search_ms, "notesMs": notes_ms, "cardsMs": cards_ms, "sortMs": sort_ms},
    }


def add_note(col, payload):
    note = new_note(col, payload)
    allow_duplicate = payload.get("options", {}).get("allowDuplicate", False)
    state = note.fields_check()
    if state != NoteFieldsCheckResult.NORMAL and not (allow_duplicate and state == NoteFieldsCheckResult.DUPLICATE):
        return None
    deck_id = col.decks.id(payload["deckName"])
    col.add_note(note, deck_id)
    return int(note.id)


def create_browser_note(col, payload):
    model = col.models.by_name(payload["modelName"])
    if not model:
        raise ValueError(f'Note type not found: {payload["modelName"]}')
    fields = {field["name"]: payload.get("fields", {}).get(field["name"], "") for field in model["flds"]}
    note_id = add_note(col, {**payload, "fields": fields, "tags": payload.get("tags", [])})
    return browser_note_info(col, col.get_note(note_id)) if note_id else None


def notes_and_cards(col, note_ids):
    notes = []
    for note_id in note_ids:
        try:
            notes.append(col.get_note(note_id))
        except NotFoundError:
            return {"error": "notFound", "noteId": note_id}
    empty = next((int(note.id) for note in notes if not note.card_ids()), None)
    if empty:
        return {"error": "noCards", "noteId": empty}
    return {"notes": notes, "cards": list(dict.fromkeys(
        int(card_id) for note in notes for card_id in note.card_ids()
    ))}


def batch_card_action(col, params, action):
    selected = notes_and_cards(col, params["notes"])
    if selected.get("error"):
        return selected
    action(selected["cards"])
    return {"cardCount": len(selected["cards"])}


def copy_notes(col, params):
    sources = []
    for note_id in params["notes"]:
        try:
            sources.append(col.get_note(note_id))
        except NotFoundError:
            return {"error": "notFound", "noteId": note_id}
    copied_ids = []
    for source in sources:
        card_ids = source.card_ids()
        deck_name = col.decks.name(col.get_card(card_ids[0]).did) if card_ids else col.decks.current()["name"]
        copied_ids.append(add_note(col, {
            "deckName": deck_name,
            "modelName": source.note_type()["name"],
            "fields": dict(source.items()),
            "tags": source.tags,
            "options": {"allowDuplicate": True},
        }))
    return {"copiedIds": copied_ids}


# A field's own settings are what Anki's Fields screen edits, and the browser draws one row of them per field.
# They are read as one named shape rather than passed through, so the browser never depends on which keys a
# collection happens to carry, and a field written by an older Anki still answers with a complete row.
FIELD_SETTINGS = ("font", "size", "rtl", "sticky", "description", "collapsed", "htmlEditor")
FIELD_DEFAULTS = {"font": "Arial", "size": 20, "rtl": False, "sticky": False, "description": "",
                  "collapsed": False, "htmlEditor": False}


def field_settings(field):
    return {"name": field["name"],
            **{key: field[key] if field.get(key) is not None else FIELD_DEFAULTS[key] for key in FIELD_SETTINGS}}


def model_info(col, model_name):
    model = col.models.by_name(model_name)
    if not model:
        raise ValueError(f'Note type not found: {model_name}')
    templates = model["tmpls"]
    if not templates:
        raise ValueError(f'Note type has no card templates: {model_name}')
    return {"name": model["name"], "fields": [field_settings(field) for field in model["flds"]],
            "sortFieldIndex": int(model.get("sortf") or 0),
            "templates": [{"name": template["name"], "front": template["qfmt"], "back": template["afmt"]}
                          for template in templates], "styling": model["css"]}


def model_infos(col):
    return [{"name": model.name, "fieldCount": len(col.models.get(model.id)["flds"]),
             "templateCount": len(col.models.get(model.id)["tmpls"])}
            for model in col.models.all_names_and_ids()]


def required_model(col, model_name):
    model = col.models.by_name(model_name)
    if not model:
        raise ValueError(f'Note type not found: {model_name}')
    return model


def required_field(model, field_name):
    field = next((field for field in model["flds"] if field["name"] == field_name), None)
    if not field:
        raise ValueError(f'Field not found: {field_name}')
    return field


def required_template(model, template_name):
    template = next((template for template in model["tmpls"] if template["name"] == template_name), None)
    if not template:
        raise ValueError(f'Card template not found: {template_name}')
    return template


def move_model_field(col, model, field, index):
    col.models.reposition_field(model, field, index)


def create_model(col, params):
    if col.models.by_name(params["name"]):
        raise ValueError(f'Note type already exists: {params["name"]}')
    model = col.models.new(params["name"])
    for name in params["fields"]:
        col.models.add_field(model, col.models.new_field(name))
    for source in params["templates"]:
        template = col.models.new_template(source["name"])
        template["qfmt"] = source["front"]
        template["afmt"] = source["back"]
        col.models.add_template(model, template)
    model["css"] = params["styling"]
    col.models.add(model)
    return model_info(col, params["name"])


# A note type's own name and the field it sorts by are the two scalars the note type owns, so they are one
# write: a rename leaves every note's fields exactly as they were, and neither needs the fields to be read.
def update_model(col, params):
    model = required_model(col, params["modelName"])
    if "name" in params and params["name"] != params["modelName"]:
        if col.models.by_name(params["name"]):
            raise ValueError(f'Note type already exists: {params["name"]}')
        model["name"] = params["name"]
    if "sortField" in params:
        index = next((position for position, field in enumerate(model["flds"])
                      if field["name"] == params["sortField"]), None)
        if index is None:
            raise ValueError(f'Field not found: {params["sortField"]}')
        col.models.set_sort_index(model, index)
    col.models.update_dict(model)
    return model_info(col, params.get("name", params["modelName"]))


def delete_model(col, params):
    model = required_model(col, params["modelName"])
    col.models.remove(model["id"])
    return {"deleted": params["modelName"]}


def add_model_field(col, params):
    model = required_model(col, params["modelName"])
    if any(field["name"] == params["name"] for field in model["flds"]):
        raise ValueError(f'Field already exists: {params["name"]}')
    field = col.models.new_field(params["name"])
    col.models.add_field(model, field)
    if "index" in params:
        move_model_field(col, model, field, params["index"])
    col.models.update_dict(model)
    return model_info(col, params["modelName"])


def update_model_field(col, params):
    model = required_model(col, params["modelName"])
    field = required_field(model, params["fieldName"])
    if "name" in params and params["name"] != params["fieldName"]:
        if any(current["name"] == params["name"] for current in model["flds"]):
            raise ValueError(f'Field already exists: {params["name"]}')
        col.models.rename_field(model, field, params["name"])
        # Anki renames the field it is handed in place, so the settings below belong to that same field; the
        # write is one call because a rename that landed without its position would leave the row half applied.
        field = required_field(model, params["name"])
    if "index" in params:
        move_model_field(col, model, field, params["index"])
    for key in FIELD_SETTINGS:
        if key in params:
            field[key] = params[key]
    col.models.update_dict(model)
    return model_info(col, params["modelName"])


def delete_model_field(col, params):
    model = required_model(col, params["modelName"])
    if len(model["flds"]) == 1:
        raise ValueError('A note type must keep at least one field')
    col.models.remove_field(model, required_field(model, params["fieldName"]))
    col.models.update_dict(model)
    return model_info(col, params["modelName"])


def add_model_template(col, params):
    model = required_model(col, params["modelName"])
    if any(template["name"] == params["name"] for template in model["tmpls"]):
        raise ValueError(f'Card template already exists: {params["name"]}')
    template = col.models.new_template(params["name"])
    template["qfmt"] = params["front"]
    template["afmt"] = params["back"]
    col.models.add_template(model, template)
    col.models.update_dict(model)
    return model_info(col, params["modelName"])


def update_model_template(col, params):
    model = required_model(col, params["modelName"])
    template = required_template(model, params["templateName"])
    if "name" in params and params["name"] != params["templateName"]:
        if any(current["name"] == params["name"] for current in model["tmpls"]):
            raise ValueError(f'Card template already exists: {params["name"]}')
        template["name"] = params["name"]
    if "front" in params:
        template["qfmt"] = params["front"]
    if "back" in params:
        template["afmt"] = params["back"]
    if "styling" in params:
        model["css"] = params["styling"]
    col.models.update_dict(model)
    return model_info(col, params["modelName"])


def delete_model_template(col, params):
    model = required_model(col, params["modelName"])
    if len(model["tmpls"]) == 1:
        raise ValueError('A note type must keep at least one card template')
    col.models.remove_template(model, required_template(model, params["templateName"]))
    col.models.update_dict(model)
    return model_info(col, params["modelName"])


def required_deck(col, deck_name):
    deck = col.decks.by_name(deck_name)
    if not deck:
        raise ValueError(f'Deck not found: {deck_name}')
    return deck


def create_deck(col, params):
    name = params["name"]
    if col.decks.by_name(name):
        raise ValueError(f'Deck already exists: {name}')
    deck_id = col.decks.id(name)
    return {"id": int(deck_id), "name": name}


def rename_deck(col, params):
    deck = required_deck(col, params["oldName"])
    new_name = params["name"]
    if new_name != params["oldName"] and col.decks.by_name(new_name):
        raise ValueError(f'Deck already exists: {new_name}')
    col.decks.rename(deck, new_name)
    return {"oldName": params["oldName"], "name": new_name}


def delete_deck(col, params):
    name = params["name"]
    if name == "Default":
        raise ValueError("The 'Default' deck cannot be deleted")
    deck = required_deck(col, name)
    col.decks.remove([deck["id"]])
    return {"deleted": name}


# Study options are Anki's deck option presets: a deck names one by id and every deck that names the same
# one shares its settings, so a preset is always read together with the decks it schedules. Anki's own
# `decks_using_config` compares the stored id to the preset's, which misses a collection that holds the id
# as a string, so the usage map is built here from the decks themselves.
def deck_config_usage(col):
    usage = {}
    for deck in col.decks.all():
        conf_id = deck.get("conf")
        if conf_id is not None:
            usage.setdefault(str(conf_id), []).append(deck["name"])
    return usage


def required_deck_config(col, config_id):
    for conf in col.decks.all_config():
        if int(conf["id"]) == config_id:
            return conf
    raise ValueError(f'Study options not found: {config_id}')


def deck_config_summary(col, conf, usage):
    return {"id": int(conf["id"]), "name": conf["name"],
            "decks": sorted(usage.get(str(conf["id"]), [])),
            # Anki moves a deck whose preset is removed back to the default one and refuses to remove that
            # preset itself, so the UI can say which preset cannot go.
            "removable": int(conf["id"]) != int(DEFAULT_DECK_CONF_ID)}


def deck_config_detail(col, conf):
    return {**conf, **deck_config_summary(col, conf, deck_config_usage(col))}


def deck_configs(col):
    usage = deck_config_usage(col)
    configs = sorted(col.decks.all_config(), key=lambda conf: conf["name"])
    return [deck_config_summary(col, conf, usage) for conf in configs]


def create_deck_config(col, params):
    name = params["name"]
    if any(conf["name"] == name for conf in col.decks.all_config()):
        raise ValueError(f'Study options already exist: {name}')
    clone = required_deck_config(col, params["cloneFrom"]) if params.get("cloneFrom") else None
    return deck_config_detail(col, col.decks.add_config(name, clone_from=clone))


def update_deck_config(col, params):
    conf = required_deck_config(col, params["configId"])
    if "name" in params:
        taken = any(other["name"] == params["name"] and int(other["id"]) != int(conf["id"])
                    for other in col.decks.all_config())
        if taken:
            raise ValueError(f'Study options already exist: {params["name"]}')
        conf["name"] = params["name"]
    # One assignment per option, because a nested dict cannot name `new.ints[0]` without replacing the
    # whole list of intervals around it.
    for assignment in params.get("settings", []):
        path = assignment["path"]
        target = conf
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = assignment["value"]
    col.decks.update_config(conf)
    return deck_config_detail(col, conf)


def delete_deck_config(col, params):
    conf = required_deck_config(col, params["configId"])
    if int(conf["id"]) == int(DEFAULT_DECK_CONF_ID):
        raise ValueError("The 'Default' study options cannot be deleted")
    name = conf["name"]
    col.decks.remove_config(int(conf["id"]))
    return {"deleted": name}


def set_deck_config(col, params):
    deck = required_deck(col, params["deck"])
    conf = required_deck_config(col, params["configId"])
    col.decks.set_config_id_for_deck_dict(deck, int(conf["id"]))
    return {"deck": deck["name"], "configId": int(conf["id"])}


def invoke(col, action, params):
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
                backup_folder = str(Path(col.path).parent / "backups")
                Path(backup_folder).mkdir(parents=True, exist_ok=True)
                col.create_backup(backup_folder=backup_folder, force=True, wait_for_completion=True)
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


def main():
    collection_path = Path(sys.argv[1]).expanduser()
    collection_path.parent.mkdir(parents=True, exist_ok=True)
    col = Collection(str(collection_path))
    try:
        ensure_caro_defaults(col)
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
