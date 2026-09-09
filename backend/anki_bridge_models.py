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
    models = []
    for model in col.models.all_names_and_ids():
        full = col.models.get(model.id)
        models.append({"name": model.name, "fields": [field["name"] for field in full["flds"]],
                       "fieldCount": len(full["flds"]), "templateCount": len(full["tmpls"])})
    return models


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
