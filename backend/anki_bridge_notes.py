import re
import time
import unicodedata
from datetime import datetime, timedelta, timezone

from anki.errors import NotFoundError
from anki.notes import NoteFieldsCheckResult

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


def card_data(col, card):
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


def card_info(col, card_id):
    try:
        card = col.get_card(card_id)
    except NotFoundError:
        return None
    return card_data(col, card)


def deck_conf(col, deck_id):
    return col.decks.config_dict_for_deck_id(deck_id)


def card_schedule(conf, card_type, interval, factor, reps, lapses):
    # A card nobody has answered has no schedule of its own yet, so it reports the values its first answer
    # would leave it with, read from the deck's own configuration — the same numbers Anki's card browser
    # shows for it. A card that has been answered reports what it holds; ease is stored in tenths of a percent.
    if card_type:
        return {"ease": round(factor / 10), "interval": interval, "lapses": lapses, "reps": reps}
    new_conf = conf.get("new") or {}
    return {
        "ease": round((new_conf.get("initialFactor") or 2500) / 10),
        "interval": (new_conf.get("ints") or [0])[0],
        "lapses": lapses,
        "reps": reps,
    }


def card_schedules(col, cards):
    # A deck's configuration is read once per deck, because a call that answers a table of cards would
    # otherwise ask the backend for the same settings once per card.
    confs = {}
    schedules = []
    for card in cards:
        if card.did not in confs:
            confs[card.did] = deck_conf(col, card.did)
        schedules.append(card_schedule(confs[card.did], card.type, card.ivl, card.factor, card.reps,
                                       card.lapses))
    return schedules


def new_note(col, payload):
    model = col.models.by_name(payload["modelName"])
    if not model:
        raise ValueError(f'Note type not found: {payload["modelName"]}')
    note = col.new_note(model)
    for name, value in payload["fields"].items():
        note[name] = value
    note.tags = payload.get("tags", [])
    return note


# The note list's own columns split in two: `fields` is the note's own content, and everything else that
# describes a card is read from the cards the note owns.
SCHEDULING_FIELDS = ("ease", "interval", "reps", "lapses")
CARD_FIELDS = {"deckName", "dueAt", "flag", *SCHEDULING_FIELDS}
NOTE_INFO_FIELDS = {"modelName", "tags", "fields", "sortField", "preview", "deckName", "dueAt", "flag",
                    *SCHEDULING_FIELDS}
NOTE_ROW_FIELDS = {"fieldValues", "sortField", "modelName", "tags", *CARD_FIELDS}


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
    card_fields = requested & CARD_FIELDS
    if not card_fields:
        return info
    cards = []
    for card_id in note.card_ids():
        try:
            cards.append(col.get_card(card_id))
        except NotFoundError:
            pass
    cards_info = [card_data(col, card) for card in cards]
    if "deckName" in card_fields:
        info["deckName"] = next((data["deckName"] for data in cards_info if data["deckName"]), None)
    if "dueAt" in card_fields:
        due_times = sorted(data["dueAt"] for data in cards_info if data["dueAt"])
        info["dueAt"] = due_times[0] if due_times else None
    if "flag" in card_fields:
        info["flag"] = next((data["flag"] for data in cards_info if data["flag"]), 0)
    # A note carrying several cards answers with the schedule of the card Anki lists first, and a note with
    # no card left at all answers with nothing rather than with an invented default.
    wanted_schedule = card_fields & set(SCHEDULING_FIELDS)
    if wanted_schedule:
        schedules = card_schedules(col, cards)
        for name in SCHEDULING_FIELDS:
            if name in wanted_schedule:
                info[name] = schedules[0][name] if schedules else None
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


# Anki's own row keys, plus any field name the caller asked to sort by: a table column sorts by the field it
# shows, so a requested field name is a sort field too. A scheduling column sorts as the number it holds
# rather than as the text a cell shows, so 9 comes before 10.
SORT_FIELDS = ("sortField", "createdAt", "dueAt", *SCHEDULING_FIELDS)
NUMERIC_SORT_FIELDS = SCHEDULING_FIELDS


def placeholder(name):
    return "{" + "{" + name + "}" + "}"


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


def named_field(note, names):
    return next((field_text(value) for name, value in note.items() if name.casefold() in names), "")


def first_field_text(note):
    return next((text for name, value in note.items() if (text := field_text(value))), "")


def note_sort_field(note):
    # A note's identity is Anki's own sort field, and a note whose sort field is empty — every field of a
    # template-filled note type, for one — falls back to its first field that holds anything.
    fields = list(note.items())
    index = note.note_type()["sortf"]
    value = field_text(fields[index][1]) if 0 <= index < len(fields) else ""
    return value or first_field_text(note)


def note_due_at(col, note):
    cards = [card_info(col, card_id) for card_id in note.card_ids()]
    due_times = sorted(card["dueAt"] for card in cards if card and card["dueAt"])
    return due_times[0] if due_times else ""


def note_sort_value(col, note, field):
    if field == "sortField":
        return note_sort_field(note)
    if field == "dueAt":
        return note_due_at(col, note)
    return named_field(note, {str(field).casefold()})


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
    wanted = [item for item in (str(name).strip() for name in (params.get("fieldNames") or [])) if item]
    requested = set(params.get("select") or NOTE_ROW_FIELDS)
    # Anki's own row keys are the only names this call knows; a column that is not one of them is a field
    # name the caller also asked to sort by, and anything unrecognized falls back to the newest note.
    field = params["sortField"] if params["sortField"] in SORT_FIELDS or params["sortField"] in wanted \
        else "createdAt"
    reverse = params["sortDirection"] == "desc"
    skip = max(0, int(params.get("skip", 0)))
    limit = max(0, int(params.get("limit", 0)))
    if field == "createdAt":
        ordered_ids = sorted(note_ids, reverse=reverse)
        page_ids = ordered_ids[skip:None if limit == 0 else skip + limit]
    else:
        ordered_ids = note_ids
        page_ids = note_ids
    need_fields = bool(wanted) or bool(requested & {"fieldValues", "sortField"})
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
        values = {}
        identity = ""
        if need_fields:
            model = col.models.get(values_by_name["mid"])
            names = [item["name"] for item in model["flds"]]
            fields = values_by_name["flds"].split("\x1f")
            shown = field_reader(fields)
            positions = {name.casefold(): index for index, name in enumerate(names)}
            values = {name: shown(positions[name.casefold()]) for name in wanted
                      if name.casefold() in positions}
            identity = shown(model["sortf"]) if model["sortf"] < len(fields) else ""
            identity = identity or next((shown(index) for index in range(len(names)) if shown(index)), "")
        elif need_model:
            model = col.models.get(values_by_name["mid"])
        if "modelName" in requested:
            row["modelName"] = model["name"]
        if "fieldValues" in requested:
            row["fieldValues"] = values
        if "sortField" in requested:
            row["sortField"] = identity
        if "tags" in requested:
            row["tags"] = values_by_name["tags"].split()
        rows[note_id] = row
        sort_values[note_id] = {"sortField": identity, "dueAt": "", **values}
    notes_ms = (time.perf_counter() - note_started) * 1000
    card_started = time.perf_counter()
    due_times = {}
    schedule_fields = (requested & set(SCHEDULING_FIELDS)) | ({field} if field in SCHEDULING_FIELDS else set())
    need_cards = field in CARD_FIELDS or bool(requested & CARD_FIELDS)
    if need_cards:
        now = datetime.now(timezone.utc)
        today = col.sched.today
        confs = {}
        first_card = {}
        raw_cards = query_for_ids(
            col, "select nid, did, ord, due, queue, type, ivl, factor, reps, lapses, flags from cards"
                 " where nid in ({placeholders})", page_ids)
        for note_id, deck_id, card_ord, due, queue, card_type, ivl, factor, reps, lapses, flags in raw_cards:
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
            if schedule_fields and card_ord < first_card.get(note_id, card_ord + 1):
                first_card[note_id] = card_ord
                if deck_id not in confs:
                    confs[deck_id] = deck_conf(col, deck_id)
                schedule = card_schedule(confs[deck_id], card_type, ivl, factor, reps, lapses)
                sort_values[note_id].update(schedule)
                for name, value in schedule.items():
                    if name in requested:
                        row[name] = value
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
            for name in schedule_fields:
                if name in requested:
                    row.setdefault(name, None)
    cards_ms = (time.perf_counter() - card_started) * 1000
    sort_started = time.perf_counter()
    if field != "createdAt":
        # A note whose type has no such field sorts after the ones that do, in the order they arrived.
        numeric = field in NUMERIC_SORT_FIELDS

        def has_value(note_id):
            value = sort_values[note_id].get(field)
            return value is not None if numeric else bool(field_text(value or ""))

        def sort_key(note_id):
            value = sort_values[note_id].get(field)
            return value if numeric else field_text(value or "")

        present = sorted((note_id for note_id in page_ids if has_value(note_id)),
                         key=lambda note_id: (sort_key(note_id), note_id), reverse=reverse)
        ordered_ids = present + [note_id for note_id in page_ids if not has_value(note_id)]
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


def find_and_replace(col, params):
    notes = []
    for note_id in params["notes"]:
        try:
            notes.append(col.get_note(note_id))
        except NotFoundError:
            return {"error": "notFound", "noteId": note_id}
    source = params["find"] if params["regularExpression"] else re.escape(params["find"])
    flags = re.IGNORECASE if params["ignoreCase"] else 0
    try:
        pattern = re.compile(source, flags)
        if params["regularExpression"]:
            pattern.sub(params["replace"], "")
    except re.error as error:
        raise ValueError(f"Invalid regular expression: {error}")
    changed_ids = []
    match_count = 0
    for note in notes:
        changes = {}
        for name, value in note.items():
            if params.get("field") and name != params["field"]:
                continue
            # Plain mode keeps replacement text literal; regex mode follows Anki/Python's backreference rules.
            replacement = params["replace"] if params["regularExpression"] else lambda _match: params["replace"]
            updated, count = pattern.subn(replacement, value)
            if count:
                changes[name] = updated
                match_count += count
        if not changes:
            continue
        for name, value in changes.items():
            note[name] = value
        col.update_note(note)
        changed_ids.append(int(note.id))
    return {"changedNoteIds": changed_ids, "changedCount": len(changed_ids), "matchCount": match_count}


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
