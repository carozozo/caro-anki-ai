from anki.decks import DEFAULT_DECK_CONF_ID

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
