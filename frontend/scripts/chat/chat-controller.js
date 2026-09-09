((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroChatController = api;
})(globalThis, () => {
  const SESSION_LIST_TITLE_MAX_LENGTH = 36;

  const sessionListTitle = title => {
    const characters = Array.from(title);
    return characters.length > SESSION_LIST_TITLE_MAX_LENGTH
      ? `${characters.slice(0, SESSION_LIST_TITLE_MAX_LENGTH).join('')}…`
      : title;
  };

  const countSteps = total => `${total} step${total === 1 ? '' : 's'}`;

  const runFailed = (steps, operationOf) => steps.some(message => operationOf(message).status === 'failed');

  const runTitle = ({ live, stopped, failed }) => (live ? 'Running…'
    : stopped ? 'Stopped' : failed ? 'Failed' : 'Completed');

  const createChatController = ({
    $,
    config,
    CaroUI,
    CaroMarkdown,
    ChatStream,
    SkillMenu,
    NoteShortcuts,
    request,
    streamChatRequest,
    state,
    getAgentSettings,
    writeBrowserView,
    readPendingChat,
    clearPendingChat,
    setStatus,
    defaultReasoningEffort,
    selectionOnlyContent,
    composerPlaceholder,
  }) => {
    const { create: createDialog } = CaroUI.dialogs;
    const { set: setSystemMessage } = CaroUI.status;
    const { armed: armedConfirm } = CaroUI.confirm;
    const { chipButton, icon, iconButton } = CaroUI.icons;
    const { escapeAttr, escapeHtml, formatCount } = CaroUI.text;
    const { autoGrow, setTextareaValue } = CaroUI.fields;
    const { render: renderMarkdown } = CaroMarkdown;
    const {
      collapseToolSteps,
      conversationParts,
      formatElapsed,
      groupSteps,
      operationJson,
      stepDetail,
      stepTitle,
    } = ChatStream;
    const { acceptSkill, clearSkill, filterSkills, pinnedSkill, skillToken } = SkillMenu;
    const { meaningFromFields, noteTerm } = CaroUI.fields;

    const setChatStatus = (text, kind = '') => setSystemMessage($('#chatStatus'), text, kind);

    const setMessageInput = value => {
      setTextareaValue($('#messageInput'), value);
      composerSkills.renderPinned(value);
    };

    const selectedReasoningEffort = () => $('#reasoningEffort').val() || defaultReasoningEffort;

    const composerFields = () => $('#messageInput, #agentName, #reasoningEffort');

    const agentAvailable = () => {
      const agentSettings = getAgentSettings();
      return agentSettings.enabled
        && agentSettings.profiles.some(profile => profile.id === agentSettings.activeProfileId);
    };

    const setComposerPending = pending => $('#composer .composer-submit')
      .toggleClass('is-pending', Boolean(pending))
      .attr('aria-label', pending ? 'Resend this message' : 'Send (Command or Control+Enter)')
      .attr('title', pending ? 'Resend this message (⌘/Ctrl+Enter)' : 'Send (⌘/Ctrl+Enter)');

    const renderComposerState = () => {
      const available = agentAvailable();
      const armed = Boolean(state.pending);
      composerFields().prop('disabled', !available || armed || state.busy);
      $('#composer button').prop('disabled', !available || state.busy);
      setComposerPending(armed);
      $('#dismissPending').prop('hidden', !armed);
      $('#chatSessions, #clearSessions').prop('disabled', state.busy);
    };

    const renderChatMode = () => {
      const agentSettings = getAgentSettings();
      const inSession = Boolean(state.activeSessionId);
      $('#chatSessions').prop('hidden', !agentSettings.enabled || !inSession);
      $('#clearSessions').prop('hidden', !agentSettings.enabled || inSession || !state.sessions.length);
      $('#sessionPanel').prop('hidden', inSession);
      $('#conversationPanel').prop('hidden', !inSession);
      writeBrowserView({ sessionId: state.activeSessionId });
    };

    const showSessions = () => {
      state.activeSessionId = null;
      renderChatMode();
      $('#chatTitle').text('ANKI AGENT');
    };

    const renderSessions = () => $('#sessionList').html(state.sessions.length
      ? state.sessions.map(session => {
        const title = sessionListTitle(session.title);
        const fullTitle = escapeAttr(session.title);
        return `<div class="session-row">
          <button class="session-item" data-session-id="${escapeAttr(session.id)}" type="button"
            aria-label="${fullTitle}" title="${fullTitle}">
            <strong>${escapeHtml(title)}</strong>
            <time>${escapeHtml(new Date(session.updated_at).toLocaleString(config.locale))}</time>
          </button>
          <button class="icon-button session-delete" data-session-id="${escapeAttr(session.id)}" type="button"
            aria-label="Delete conversation" title="Delete conversation">${icon('trash')}</button>
        </div>`;
      }).join('')
      : '<div class="empty-state compact">No conversations yet. Enter a request to start.</div>');

    const loadSessions = async () => {
      const { sessions } = await request('/api/sessions');
      state.sessions = sessions;
      renderSessions();
      renderChatMode();
    };

    const retryButton = retry => iconButton({
      className: 'message-retry',
      icon: 'retry',
      label: 'Retry',
      title: 'Retry the previous request',
      attributes: `data-retry-content="${escapeAttr(retry.content)}" `
        + `data-retry-selection="${escapeAttr(JSON.stringify(retry.selectionNoteIds || []))}"`,
    });

    const previewContentHtml = (path, content) => `<div class="operation-save-preview">
        <span class="operation-save-preview-path">${escapeHtml(path)}</span>
        ${content === undefined ? '' : `<pre>${escapeHtml(content)}</pre>`}</div>`;

    const previewButtonHtml = (title, content) => `<button class="button button-quiet button-with-icon
        operation-save-preview-button" type="button" aria-haspopup="dialog" aria-controls="agentProposalPreviewDialog"
        data-preview-title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}"
        title="${escapeAttr(title)}">${icon('eye')}<span>Preview</span></button>
      <template class="operation-save-preview-template">${content}</template>`;

    const previewContentFor = save => {
      if (save.op === 'rename') return previewContentHtml(`${save.name} → ${save.to}`);
      if (save.op === 'remove') {
        return previewContentHtml(`${save.name} · removes the ${save.kind === 'skill' ? 'skill folder' : 'file'}`);
      }
      if (save.kind === 'skill') return save.files.map(file => previewContentHtml(file.path, file.content)).join('');
      return previewContentHtml(save.kind === 'instruction' ? save.name : 'Preview', save.content);
    };

    const previewsHtml = save => {
      const content = previewContentFor(save);
      if (save.op === 'write' && (save.kind === 'instruction' || save.kind === 'skill')) {
        const label = save.kind === 'instruction' ? `Instruction ${save.name}` : `Skill ${save.name}`;
        return previewButtonHtml(`Preview ${label}`, content);
      }
      return content;
    };

    const saveEntryHtml = save => {
      const { kind, name } = save;
      const label = kind === 'skill' ? `Skill ${name}` : kind === 'profile' ? `Card profile ${name}` : name;
      return `<div class="operation-save" data-kind="${escapeAttr(kind)}">
        <span class="operation-save-name">${escapeHtml(label)}</span>
        ${previewsHtml(save)}
      </div>`;
    };

    const renderSaves = saves => (saves.length
      ? `<div class="operation-saves">${saves.map(saveEntryHtml).join('')}</div>`
      : '');

    const operationOf = message => JSON.parse(message.content);

    const renderMessage = (message, { live = false } = {}) => {
      if (message.role !== 'tool') {
        const payload = message.payload_json ? JSON.parse(message.payload_json) : null;
        const retry = message.role === 'assistant' && payload?.failed ? payload.retry : null;
        const body = message.role === 'assistant'
          ? `<div class="message-body">${renderMarkdown(message.content)}</div>`
          : `<p>${escapeHtml(message.content)}</p>`;
        return `<article class="message message-${escapeAttr(message.role)}">
          <span>${escapeHtml(message.role)}</span>${body}
          ${retry ? retryButton(retry) : ''}
        </article>`;
      }
      const operation = operationOf(message);
      const { status, result } = operation;
      const recorded = [...(result?.notes || []), result?.before, result?.after, result]
        .filter(note => note?.fields);
      const termById = new Map(recorded
        .map(note => [Number(note.noteId ?? note.id), noteTerm(note) || meaningFromFields(note.fields)])
        .filter(([id]) => Number.isSafeInteger(id)));
      const ids = result?.noteIds?.filter(Boolean) || (result?.id ? [result.id] : [...termById.keys()]);
      const labelFor = id => termById.get(Number(id)) || `note ${Number(id)}`;
      const links = status === 'completed' && !result?.deleted && ids.length
        ? `<div class="operation-notes">${ids.map(id =>
          `<button class="locate-note" data-note-id="${Number(id)}" type="button"
            aria-label="Edit ${escapeAttr(labelFor(id))}" title="Edit ${escapeAttr(labelFor(id))}"
            >${escapeHtml(labelFor(id))}</button>`).join('')}</div>`
        : '';
      return `<details class="operation${live && status === 'pending' ? ' is-running' : ''}">
        <summary>${escapeHtml(stepTitle(operation))}</summary>
        <pre>${escapeHtml(stepDetail(operation, labelFor))}</pre>
        <details class="operation-raw"><summary>Raw JSON</summary>
          <pre>${escapeHtml(operationJson(operation, message))}</pre></details></details>${links}`;
    };

    const runHeadHtml = ({ title, meta = '', live = false }) => `<div class="chat-run-head">
        <button class="chat-run-toggle" type="button" aria-expanded="${live}">
          <svg class="icon chat-run-chevron" aria-hidden="true" focusable="false"><use href="#i-chevron-right"></use></svg>
          ${live ? '<span class="chat-run-spinner" aria-hidden="true"></span>' : ''}
          <span class="chat-run-title">${escapeHtml(title)}</span>
          <span class="chat-run-meta">${escapeHtml(meta)}</span>
        </button>
        <button class="chat-run-stop button button-quiet button-with-icon" type="button" hidden
          aria-label="Stop this run" title="Stop this run">
          <svg aria-hidden="true" focusable="false"><use href="#i-stop"></use></svg><span>Stop</span>
        </button>
      </div>`;

    const runWindowHtml = (steps, { live = false, stopped = false } = {}) => `<div class="chat-run${live ? '' : ' is-collapsed'}">
      ${runHeadHtml({ live, title: runTitle({ live, stopped, failed: runFailed(steps, operationOf) }),
        meta: live ? '' : countSteps(steps.length) })}
      <div class="chat-run-body">${steps.map(message =>
        `<div class="chat-step">${renderMessage(message, { live })}</div>`).join('')}</div>
    </div>`;

    const renderConversation = parts => parts
      .map(part => part.previews ? renderSaves(part.previews)
        : part.steps ? runWindowHtml(part.steps, { stopped: part.stopped })
        : renderMessage(part.message))
      .join('');

    const selectionLabel = selection => selection.map(item => item.term).join(', ');

    const renderChatSelection = selection => {
      state.selection = selection;
      const count = selection.length;
      const label = selectionLabel(selection);
      $('#chatSelectionText').text(`Selected ${formatCount(count)} note${count === 1 ? '' : 's'}: ${label}`);
      $('#chatSelection').prop('hidden', !count)
        .attr('title', count
          ? `AI will target these ${formatCount(count)} note${count === 1 ? '' : 's'}: ${label}`
          : '');
    };

    const scrollMessagesToBottom = () => {
      const list = $('#messageList')[0];
      if (list) list.scrollTop = list.scrollHeight;
    };

    const activity = {
      startedAt: 0,
      requestId: null,
      $run: null,
      $body: null,
      $step: null,
      $answer: null,
      timer: null,
      stopTimer: null,
      effort: null,
      failed: false,
      answerText: '',
      paintTimer: null,
      begin (requestId) {
        this.startedAt = performance.now();
        this.requestId = requestId;
        this.$step = null;
        this.$answer = null;
        this.effort = null;
        this.failed = false;
        this.answerText = '';
        this.$run = $(runWindowHtml([], { live: true })).appendTo('#messageList');
        this.$body = this.$run.find('.chat-run-body');
        this.paintMeta();
        this.timer = window.setInterval(() => this.paintMeta(), 500);
        this.stopTimer = window.setTimeout(() => this.$run?.find('.chat-run-stop').prop('hidden', false),
          config.timings.agentStopMs);
        scrollMessagesToBottom();
      },
      paintMeta () {
        if (!this.$body) return;
        const { effort, source } = this.effort || {};
        const suffix = effort
          ? ` · Effort ${effort}${source === 'fallback' ? ' (auto unavailable)' : ' (auto)'}` : '';
        this.$run.find('.chat-run-meta').text(
          `${countSteps(this.$body.children().length)} · ${formatElapsed(performance.now() - this.startedAt)}${suffix}`);
      },
      scroll () {
        const body = this.$body?.[0];
        if (body) body.scrollTop = body.scrollHeight;
        scrollMessagesToBottom();
      },
      handle (event) {
        if (event.type === 'effort') {
          this.effort = event;
          this.paintMeta();
        } else if (event.type === 'phase') {
          this.resetAnswer();
        } else if (event.type === 'tool') this.showStep(event);
        else if (event.type === 'answer') this.streamAnswer(event);
      },
      streamAnswer ({ delta = '', reset = false }) {
        if (reset) this.resetAnswer();
        if (!delta) return;
        this.answerText += delta;
        if (!this.$answer) {
          this.$answer = $('<article class="message message-assistant is-streaming"><span>assistant</span>'
            + '<div class="message-body message-stream"></div></article>').appendTo('#messageList');
        }
        if (this.paintTimer) return;
        this.paintAnswer();
        this.paintTimer = window.setTimeout(() => {
          this.paintTimer = null;
          this.paintAnswer();
        }, config.timings.markdownMs);
      },
      paintAnswer () {
        if (!this.$answer) return;
        this.$answer.find('.message-stream').html(renderMarkdown(this.answerText));
        scrollMessagesToBottom();
      },
      resetAnswer () {
        window.clearTimeout(this.paintTimer);
        this.paintTimer = null;
        this.answerText = '';
        this.$answer?.remove();
        this.$answer = null;
      },
      showStep ({ operation, message }) {
        const $row = $(`<div class="chat-step"></div>`)
          .append(renderMessage({ ...message, content: JSON.stringify(operation) }, { live: true }));
        if (this.$step) this.$step.replaceWith($row);
        else this.$body.append($row);
        this.$step = operation.status === 'pending' ? $row : null;
        if (operation.status === 'failed') this.failed = true;
        this.paintMeta();
        this.scroll();
      },
      end (stopped = false) {
        window.clearInterval(this.timer);
        window.clearTimeout(this.stopTimer);
        this.timer = null;
        this.stopTimer = null;
        this.$step = null;
        this.resetAnswer();
        const $run = this.$run;
        if ($run) {
          $run.addClass('is-collapsed');
          $run.find('.chat-run-spinner').remove();
          $run.find('.chat-run-title').text(runTitle({ live: false, stopped, failed: this.failed }));
          $run.find('.chat-run-stop').prop('hidden', true);
        }
        this.$run = null;
        this.$body = null;
        this.requestId = null;
      },
    };

    const loadSession = async id => {
      const payload = await request(`/api/sessions/${encodeURIComponent(id)}`);
      state.activeSessionId = id;
      renderChatMode();
      $('#chatTitle').text(payload.session.title);
      const messages = collapseToolSteps(payload.messages);
      $('#messageList').html(renderConversation(groupSteps(conversationParts(messages))));
      scrollMessagesToBottom();
    };

    const createSession = async title => {
      const { session } = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ title }) });
      await loadSessions();
      await loadSession(session.id);
    };

    const proposalPreviewDialog = createDialog({
      selector: '#agentProposalPreviewDialog',
      onClose: () => {
        $('#agentProposalPreviewTitle').text('Preview');
        $('#agentProposalPreviewContent').empty();
      },
    });

    $(document).on('anki-selection-change', (_event, selection) => renderChatSelection(selection || []));
    $('#clearChatSelection').on('click', () => {
      if (state.busy || state.pending) return;
      $(document).trigger('anki-clear-selection');
    });

    $('#chatSessions').on('click', () => {
      if (state.busy) return;
      showSessions();
      $('#messageInput').trigger('focus');
    });

    const clearSessionsConfirm = armedConfirm(async () => {
      state.busy = true;
      renderComposerState();
      try {
        await request('/api/sessions', { method: 'DELETE' });
        state.pending = null;
        showSessions();
        await loadSessions();
        setChatStatus('Chat history cleared.', 'ok');
      } catch (error) {
        setStatus('error', error.message);
      } finally {
        state.busy = false;
        renderComposerState();
      }
    });

    $('#clearSessions').on('click', event => {
      if (state.busy) return;
      clearSessionsConfirm.handle(event, 'Click again to clear chat history');
    });

    $('#sessionList').on('click', '.session-item', async event => {
      if (state.busy) return;
      state.busy = true;
      renderComposerState();
      try { await loadSession($(event.currentTarget).data('session-id')); }
      catch (error) { setStatus('error', error.message); }
      finally {
        state.busy = false;
        renderComposerState();
      }
    });

    const sessionDeleteConfirm = armedConfirm(async $button => {
      const id = $button.data('session-id');
      state.busy = true;
      renderComposerState();
      try {
        await request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const armed = state.pending || readPendingChat();
        if (state.activeSessionId === id || armed?.sessionId === id) {
          state.pending = null;
          clearPendingChat();
          showSessions();
        }
        await loadSessions();
        setChatStatus('Conversation deleted.', 'ok');
      } catch (error) {
        setStatus('error', error.message);
      } finally {
        state.busy = false;
        renderComposerState();
      }
    });

    $('#sessionList').on('click', '.session-delete', event => {
      event.stopPropagation();
      if (state.busy) return;
      sessionDeleteConfirm.handle(event, 'Click again to delete this conversation');
    });

    // The composer slash menu
    const composerSkills = {
      skills: null,
      loading: null,
      loadToken: 0,
      pinned: '',
      $list: () => $('#composerSkills'),
      options: () => $('#composerSkills').find('.composer-skill'),
      isOpen: () => !$('#composerSkills').is('[hidden]'),
      close () {
        this.$list().prop('hidden', true).empty();
        $('#messageInput').attr('aria-expanded', 'false');
      },
      load () {
        if (!this.loading) {
          const token = ++this.loadToken;
          this.loading = request('/api/skills')
            .then(payload => { if (token === this.loadToken) this.skills = payload.skills || []; })
            .catch(() => { if (token !== this.loadToken) return; this.skills = []; this.loading = null; });
        }
        return this.loading;
      },
      invalidate () {
        this.loadToken += 1;
        this.loading = null;
        this.load().then(() => this.renderPinned($('#messageInput').val()));
      },
      renderPinned (value) {
        const skill = (this.pinned && (this.skills || []).find(entry => entry.name === this.pinned))
          || pinnedSkill(value, this.skills);
        if (this.pinned === (skill?.name ?? '')) return;
        this.pinned = skill?.name ?? '';
        const hint = skill?.argumentHint || '';
        $('#composerSkillChips').prop('hidden', !skill).html(skill ? chipButton({
          text: `/${skill.name}`,
          label: `Remove the skill /${skill.name} from this message`,
          title: `Send without /${skill.name}`,
        }) : '');
        $('#messageInput').attr('placeholder', skill && hint ? hint : composerPlaceholder);
      },
      update () {
        const value = $('#messageInput').val();
        const token = skillToken(value);
        this.load().then(() => {
          this.renderPinned(value);
          if (this.pinned) { this.close(); return; }
          if (token === null) { this.close(); return; }
          if (token !== skillToken($('#messageInput').val())) return;
          const matches = filterSkills(this.skills, token);
          if (!matches.length) { this.close(); return; }
          this.render(matches);
        });
      },
      render (skills) {
        this.$list().html(skills.map(skill => `<button class="composer-skill" type="button" role="option"
          data-skill="${escapeAttr(skill.name)}" aria-selected="false"
          ><span class="composer-skill-name">/${escapeHtml(skill.name)}</span>${
  skill.description
    ? `<span class="composer-skill-description">${escapeHtml(skill.description)}</span>` : ''}</button>`)
          .join('')).prop('hidden', false);
        this.activate(this.options().first());
        $('#messageInput').attr('aria-expanded', 'true');
      },
      activate ($option) {
        this.options().removeClass('is-active').attr('aria-selected', 'false');
        $option.addClass('is-active').attr('aria-selected', 'true');
      },
      move (key) {
        const $options = this.options();
        if (!$options.length) return;
        const index = $options.index($options.filter('.is-active'));
        const next = key === 'ArrowDown' ? (index + 1) % $options.length
          : (index <= 0 ? $options.length : index) - 1;
        this.activate($options.eq(next));
        $options.eq(next)[0].scrollIntoView({ block: 'nearest' });
      },
      accept () {
        const $options = this.options();
        const $picked = $options.filter('.is-active').first();
        const name = ($picked.length ? $picked : $options.first()).data('skill');
        this.close();
        if (!name) return;
        this.pinned = null;
        this.renderPinned(`/${name}`);
        setMessageInput(clearSkill(acceptSkill($('#messageInput').val(), name)));
        $('#messageInput').trigger('focus');
      },
      content () {
        const value = $('#messageInput').val().trim();
        return this.pinned ? `/${this.pinned}${value ? ` ${value}` : ''}` : value;
      },
      clear () {
        this.pinned = null;
        setMessageInput('');
      },
    };

    $('#messageInput').on('input', event => {
      autoGrow($(event.currentTarget));
      composerSkills.update();
    });

    $('#messageInput').on('keydown', event => {
      if (!composerSkills.isOpen()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        composerSkills.close();
        return;
      }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        composerSkills.move(event.key);
        return;
      }
      if (['Enter', 'Tab'].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey
        && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        composerSkills.accept();
      }
    });

    $('#composerSkills').on('mousedown', event => event.preventDefault());
    $('#composerSkills').on('click', '.composer-skill', event => {
      composerSkills.activate($(event.currentTarget));
      composerSkills.accept();
    });

    $('#composerSkillChips').on('click', '.anki-tag-chip', () => {
      if (state.busy || state.pending) return;
      composerSkills.pinned = null;
      setMessageInput(clearSkill($('#messageInput').val()));
      $('#messageInput').trigger('focus');
    });

    $(document).on('mousedown', event => {
      if (!$(event.target).closest('#composer').length) composerSkills.close();
    });

    $('#messageInput').on('keydown', event => {
      const sendShortcut = NoteShortcuts.find('send-chat');
      if (event.defaultPrevented || !NoteShortcuts.matches(event, sendShortcut) || event.isComposing) return;
      event.preventDefault();
      $('#composer').trigger('submit');
    });

    $('#messageList').on('click', '.chat-run-toggle', event => {
      const $run = $(event.currentTarget).closest('.chat-run');
      const collapsed = $run.toggleClass('is-collapsed').hasClass('is-collapsed');
      $(event.currentTarget).attr('aria-expanded', String(!collapsed));
    });

    $('#messageList').on('click', '.chat-run-stop', async event => {
      const $button = $(event.currentTarget);
      if ($button.prop('disabled') || !activity.requestId) return;
      $button.prop('disabled', true).find('span').text('Stopping…');
      try {
        const { cancelled } = await request('/api/agent/cancel', {
          method: 'POST', body: JSON.stringify({ requestId: activity.requestId }),
        });
        if (cancelled) setChatStatus('Stopping after the current step.', 'warn');
        else $button.prop('disabled', false).find('span').text('Stop');
      } catch (error) {
        $button.prop('disabled', false).find('span').text('Stop');
        setChatStatus(error.message, 'error');
      }
    });

    $('#messageList').on('click', '.operation-save-preview-button', event => {
      const $button = $(event.currentTarget);
      const template = $button.siblings('.operation-save-preview-template')[0];
      $('#agentProposalPreviewTitle').text($button.attr('data-preview-title'));
      $('#agentProposalPreviewContent')[0].replaceChildren(template.content.cloneNode(true));
      proposalPreviewDialog.open();
    });

    $('#messageList').on('click', '.message-retry', event => {
      if (state.busy || state.pending || !state.activeSessionId) return;
      const $button = $(event.currentTarget);
      const content = $button.attr('data-retry-content') || '';
      if (!content) return;
      state.pending = {
        content,
        requestId: crypto.randomUUID(),
        sessionId: state.activeSessionId,
        selectionNoteIds: JSON.parse($button.attr('data-retry-selection') || '[]'),
        reasoningEffort: selectedReasoningEffort(),
        retry: true,
      };
      sessionStorage.setItem(config.storageKeys.pendingChat, JSON.stringify(state.pending));
      $('#composer').trigger('submit');
    });

    $('#composer').on('submit', async event => {
      event.preventDefault();
      if (state.busy) return;
      const content = state.pending?.content ?? (composerSkills.content()
        || (state.selection.length ? selectionOnlyContent : ''));
      if (!content) return;
      state.busy = true;
      composerSkills.close();
      renderComposerState();
      setChatStatus('');
      let completedOperations = [];
      let cancelled = false;
      let sentSelection = false;
      try {
        if (!state.activeSessionId) await createSession(content.slice(0, 60));
        if (!state.pending) {
          state.pending = {
            content,
            requestId: crypto.randomUUID(),
            sessionId: state.activeSessionId,
            reasoningEffort: selectedReasoningEffort(),
            selectionNoteIds: state.selection.map(item => item.id),
          };
          sentSelection = state.pending.selectionNoteIds.length > 0;
          $('#messageList').append(renderMessage({ role: 'user', content }));
          scrollMessagesToBottom();
        }
        const sessionId = state.pending?.sessionId || state.activeSessionId;
        if (state.pending && sessionId !== state.activeSessionId) await loadSession(sessionId);
        composerSkills.clear();
        activity.begin(state.pending?.requestId);
        const chatRequest = streamChatRequest(
          `/api/sessions/${encodeURIComponent(sessionId)}/chat`, state.pending,
          { onEvent: e => activity.handle(e) });
        if (sentSelection) $(document).trigger('anki-clear-selection');
        const payload = await chatRequest;
        completedOperations = payload.operations || [];
        cancelled = payload.cancelled === true;
        state.pending = null;
        await loadSession(sessionId);
        await loadSessions();
        if (payload.failed) setChatStatus('Operation aborted — check the log.', 'error');
        else if (payload.cancelled) setChatStatus('');
      } catch (error) {
        if (error.code !== 'run_pending') {
          state.pending = null;
          await loadSession(state.activeSessionId).catch(() => {});
        }
        setChatStatus(error.message, 'error');
      } finally {
        activity.end(cancelled);
        state.busy = false;
        composerSkills.invalidate();
        renderComposerState();
        $(document).trigger('anki-agent-finished', [completedOperations]);
      }
    });

    $('#dismissPending').on('click', () => {
      state.pending = null;
      clearPendingChat();
      setMessageInput('');
      renderComposerState();
      setChatStatus('Records kept. Verify the result in Anki before retrying.', 'warn');
      loadSession(state.activeSessionId).catch(error => setStatus('error', error.message));
    });

    const focusChatComposer = () => {
      $('#ankiBrowserPannel').trigger('show-chat');
      $('#messageInput').trigger('focus');
    };

    return {
      activity,
      composerSkills,
      createSession,
      focusChatComposer,
      loadSession,
      loadSessions,
      renderChatMode,
      renderChatSelection,
      renderComposerState,
      renderConversation,
      renderMessage,
      renderSessions,
      setChatStatus,
      setMessageInput,
      showSessions,
    };
  };

  return { createChatController, sessionListTitle };
});
