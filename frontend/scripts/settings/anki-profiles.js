((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroAnkiProfiles = api;
})(globalThis, () => {
  // The collection profiles panel: which collection is open, creating another one, renaming it (a write that
  // moves a folder and is therefore asked for twice), switching to it, and deleting it. It is one section of the
  // settings dialog, so it owns only its own status line.
  const createAnkiProfiles = ({ $, CaroUI, request, clearPendingChat, writeBrowserView }) => {
    const { set: setSystemMessage } = CaroUI.status;
    const { armed: armedConfirm } = CaroUI.confirm;
    const { pickerRow } = CaroUI.fields;

    let ankiProfileReloadRequired = false;
    let ankiProfileSaving = false;
    const setAnkiProfileStatus = (text, kind = '') => setSystemMessage($('#ankiProfileStatus'), text, kind);

    const ankiProfiles = CaroUI.entityManager({
      list: async () => {
        const { activeProfileId, profiles } = await request('/api/profiles');
        ankiProfiles.activeId = activeProfileId;
        return profiles;
      },
      create: async name => (await request('/api/profiles', { method: 'POST', body: JSON.stringify({ name }) })).profile,
      rename: async (profile, name) => {
        const result = await request(`/api/profiles/${encodeURIComponent(profile.id)}/rename`, {
          method: 'POST', body: JSON.stringify({ name }),
        });
        ankiProfileReloadRequired = result.reloadRequired;
        return result.profile;
      },
      remove: async profile => request(`/api/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' }),
      canRename: profile => Boolean(profile?.active) && Boolean(profile?.canRename),
      canDelete: profile => Boolean(profile) && !profile.active && Boolean(profile.canActivate) && profile.managed,
    });
    ankiProfiles.activeId = null;

    const ankiProfileById = id => ankiProfiles.items().find(profile => profile.id === id);
    const activeAnkiProfile = () => ankiProfileById(ankiProfiles.activeId) || null;
    // The row falls back to the profile that is actually open while the list is still loading, so what the row's
    // own two buttons are offered for is read from here instead of straight off the manager's selection.
    const shownAnkiProfile = () => ankiProfiles.selected() || activeAnkiProfile();
    const ankiProfileReady = () => !ankiProfileSaving && $('#ankiSettingsPanel').attr('aria-busy') !== 'true';

    // Profiles are the one list whose entity is a whole collection rather than a name in one, so the row shows
    // one sentence at a time under it: what is open, what a rename would move, and — while the form for one is
    // showing — the fact that this write is asked for twice, which is the only place the second press is stated
    // before it is made.
    const renderAnkiProfileHelp = mode => {
      const profile = shownAnkiProfile();
      const ready = ankiProfileReady();
      const canRename = ankiProfiles.canRename() && ready;
      $('#ankiProfileHelp').text(mode === 'rename'
        ? 'Renaming moves this collection, its media, and its backups into the folder the new name gives it, so'
          + ' the write is asked for twice: press Enter again on the button to move it.'
        : !ready ? 'Loading the collection before profile changes are available.'
        : !profile
          ? 'Create a profile to start an empty collection with its own defaults, AnkiWeb account, and chats.'
          : canRename
            ? `Current folder: ${profile.storageName}. Renaming moves the collection, media, and backups together,`
              + ' and the active profile is the one that cannot be deleted.'
            : profile.active
              ? 'This collection is managed outside Caro Anki, so it cannot be renamed or deleted here.'
              : `Select Switch to open ${profile.name}, or delete it: the whole folder is copied into`
                + ' profile-backups first. Only the profile that is currently open can be renamed.');
    };

    // A write repaints the row and the row's own `run` is that write, so the two are circular: the write is
    // declared first and the row's paint is the one thing it takes from the row at call time.
    //
    // Every profile write goes through here, which is what the row inherits: one at a time, with the row's own
    // buttons standing down while one is in flight. It is also where the reload belongs — a rename moves the
    // collection's folder and a switch points the app at another one, so either way the page re-reads the path
    // before a collection is opened again. A write whose sentence depends on its own answer (a delete says
    // whether the collection was backed up first) answers with that sentence instead of being given one.
    const writeAnkiProfile = async (work, success, { onSaved } = {}) => {
      if (ankiProfileSaving) return;
      ankiProfileSaving = true;
      renderAnkiProfile();
      setAnkiProfileStatus('Saving…', 'pending');
      try {
        const answer = await work();
        const sentence = success ?? answer;
        setAnkiProfileStatus(ankiProfileReloadRequired ? `${sentence} Reloading…` : sentence, 'ok');
        await onSaved?.();
        if (ankiProfileReloadRequired) {
          ankiProfileReloadRequired = false;
          window.setTimeout(() => window.location.reload(), 350);
        }
      } catch (error) {
        setAnkiProfileStatus(error.message, 'error');
      } finally {
        ankiProfileSaving = false;
        renderAnkiProfile();
      }
    };

    // The section is painted by the row: every change to the selection, to the mode, or to a write in flight goes
    // through the row's own render, so the callers that only know "the profiles are ready" call this.
    const renderAnkiProfile = () => profilePicker.render();

    // The list, the profile that is open, the form for a new one, and the two writes are one control, exactly as
    // in the studios. Two things this row has that a studio's does not: the switch beside it, which opens the
    // collection the list is showing and is therefore not the row's own confirm button, and a rename that is
    // armed, because it moves a folder rather than a name.
    const profilePicker = pickerRow({
      manager: ankiProfiles,
      ids: {
        select: '#ankiProfileSelect', rename: '#ankiProfileName', create: '#ankiNewProfileName',
        confirm: '#ankiProfileConfirm', back: '#ankiProfileReturn', remove: '#ankiProfileDelete',
      },
      sentinel: '- New Profile -',
      entity: 'profile',
      option: {
        value: item => item.id,
        label: item => `${item.name}${item.active ? ' (current)' : ''}`,
        name: item => item.name,
      },
      isReady: ankiProfileReady,
      run: writeAnkiProfile,
      // The row hands over the key of the entity it is renaming, and this list is keyed by an id while the
      // request is made with the profile itself, so the one rename the manager takes is spelled out.
      rename: (id, name) => ankiProfiles.rename(ankiProfileById(id), name),
      arm: {
        className: 'button-confirm',
        hint: name => `Press Enter again to rename this collection to "${name}"`,
      },
      messages: {
        created: name => `${name} is ready. Select Switch to open it.`,
        renamed: (from, name) => `Renamed ${from} to ${name}.`,
      },
      // The switch opens a collection rather than writing the list, so it is only there while the list is, and
      // the delete only ever destroys a profile that is not the open one; both stand down during a write and
      // while the panel is still loading them.
      onMode: mode => {
        const ready = ankiProfileReady();
        const profile = shownAnkiProfile();
        $('#ankiProfileActivate').prop('hidden', mode !== 'pick')
          .prop('disabled', !(ready && profile?.canActivate && !profile.active));
        $('#ankiProfileDelete').prop('disabled', !(ready && ankiProfiles.canDelete()));
        renderAnkiProfileHelp(mode);
      },
      onPick: () => setAnkiProfileStatus(''),
    });

    const loadAnkiProfiles = async () => {
      await ankiProfiles.load(ankiProfiles.activeId);
      // The list states which collection is open in an answer rather than in its order, so the row is put on
      // that profile instead of on whatever came first: the row's own two writes are offered for what it shows,
      // and opening Settings on a profile that is not the one in use offers to delete a collection that is not
      // the one being deleted.
      ankiProfiles.select(ankiProfiles.activeId);
      renderAnkiProfile();
      return ankiProfiles;
    };

    const activateAnkiProfile = async () => {
      const profile = shownAnkiProfile();
      if (!profile || profile.active) return;
      await writeAnkiProfile(async () => {
        const result = await request(`/api/profiles/${encodeURIComponent(profile.id)}/activate`, {
          method: 'POST', body: JSON.stringify({}),
        });
        clearPendingChat();
        writeBrowserView({ sessionId: null });
        await ankiProfiles.load(result.profile.id);
        ankiProfileReloadRequired = result.reloadRequired;
        return 'Profile switched.';
      });
    };

    const deleteAnkiProfileConfirm = armedConfirm(() => {
      const profile = shownAnkiProfile();
      if (!profile) return setAnkiProfileStatus('Select a collection profile to delete.', 'error');
      return writeAnkiProfile(async () => {
        const result = await ankiProfiles.remove(profile);
        ankiProfiles.select(result.activeProfileId);
        return result.backupCreated
          ? `${result.removed} was deleted. Its collection was copied into profile-backups first.`
          : `${result.removed} was deleted.`;
      });
    });

    $('#ankiProfileDelete').on('click', event => {
      if (!ankiProfiles.canDelete() || !ankiProfileReady()) return;
      deleteAnkiProfileConfirm.handle(event, 'Click again to delete this collection and its chats');
    });
    $('#ankiProfileActivate').on('click', () => activateAnkiProfile());
    $('#ankiProfileName').on('input', () => setAnkiProfileStatus(''));

    return {
      load: loadAnkiProfiles,
      render: renderAnkiProfile,
      setPanelStatus: setAnkiProfileStatus,
    };
  };

  return { createAnkiProfiles };
});
