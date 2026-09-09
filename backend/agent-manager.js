const { DeepSeekProvider, AUTO_REASONING_EFFORT, EFFORT_CHOICES } = require('./providers/deepseek-provider');
const { AnkiAgent } = require('./anki-agent');
const { DEFAULT_AGENT_LANGUAGE, agentLanguageOptions, isAgentLanguage } = require('./agent-language');
const { agentStepLimit } = require('./agent-limits');

class AgentManager {
  constructor ({ repository, keychain, browser, client, ankiConfig, skills = null, instructions = null, memories = null,
    cardProfiles = null }) {
    Object.assign(this, {
      repository, keychain, browser, client, ankiConfig, skills, instructions, memories, cardProfiles,
    });
  }

  async settings () {
    const settings = this.repository.getAgentSettings();
    const profiles = await Promise.all(this.repository.listAgentProfiles().map(async profile => ({
      ...profile, hasApiKey: Boolean(await this.keychain.get(profile.id)),
    })));
    return {
      enabled: settings.enabled,
      activeProfileId: settings.activeProfileId,
      defaultLanguage: DEFAULT_AGENT_LANGUAGE,
      languages: agentLanguageOptions(),
      profiles,
    };
  }

  // The provider is handed the profile's choice as-is: `apiEffort` resolves a stored `auto` for the
  // callers that never classify (card generation), while the agent reads it as its own fallback.
  async getAgent () {
    const { enabled, activeProfileId, profiles } = await this.settings();
    if (!enabled) throw Object.assign(new Error('Anki Agent is disabled'), { statusCode: 503 });
    const profile = profiles.find(item => item.id === activeProfileId);
    if (!profile) throw Object.assign(new Error('Select an Anki Agent configuration'), { statusCode: 503 });
    const apiKey = await this.keychain.get(profile.id);
    if (!apiKey) throw Object.assign(new Error('The active Agent configuration has no API key'), { statusCode: 503 });
    const provider = new DeepSeekProvider({ apiKey, model: profile.model, baseUrl: profile.baseUrl,
      reasoningEffort: profile.reasoningEffort });
    return new AnkiAgent({ provider, browser: this.browser, client: this.client, config: this.ankiConfig,
      skills: this.skills, instructions: this.instructions, memories: this.memories, cardProfiles: this.cardProfiles,
      language: profile.language, stepLimit: profile.stepLimit });
  }

  validate (input) {
    const profile = {
      name: String(input.name || '').trim(), provider: input.provider || 'deepseek',
      model: String(input.model || '').trim(), baseUrl: String(input.baseUrl || '').trim(),
      reasoningEffort: input.reasoningEffort || AUTO_REASONING_EFFORT,
      language: input.language ?? DEFAULT_AGENT_LANGUAGE,
      stepLimit: agentStepLimit(input.stepLimit),
    };
    if (!profile.name || !profile.model || !profile.baseUrl) throw new Error('name, model and baseUrl are required');
    if (profile.provider !== 'deepseek') throw new Error('provider must be deepseek');
    if (!EFFORT_CHOICES.includes(profile.reasoningEffort)) throw new Error('Invalid reasoning effort');
    if (!isAgentLanguage(profile.language)) throw new Error('Invalid default language');
    new URL(profile.baseUrl);
    return profile;
  }

  assertUniqueName (name, ignoredId = null) {
    const duplicate = this.repository.listAgentProfiles()
      .some(profile => profile.id !== ignoredId && profile.name === name);
    if (duplicate) {
      throw Object.assign(new Error('Agent configuration name already exists'), { statusCode: 409 });
    }
  }

  async create (input) {
    const apiKey = String(input.apiKey || '').trim();
    if (!apiKey) throw new Error('apiKey is required');
    const next = this.validate(input);
    this.assertUniqueName(next.name);
    const profile = this.repository.createAgentProfile(next);
    try {
      await this.keychain.set(profile.id, apiKey);
      return { ...profile, hasApiKey: true };
    } catch (error) {
      this.repository.deleteAgentProfile(profile.id);
      throw error;
    }
  }

  async update (id, input) {
    const current = this.repository.getAgentProfile(id);
    if (!current) return null;
    const next = this.validate({ ...current, ...input });
    this.assertUniqueName(next.name, id);
    const apiKey = String(input.apiKey || '').trim();
    if (!apiKey && !(await this.keychain.get(id))) throw new Error('apiKey is required');
    if (apiKey) await this.keychain.set(id, apiKey);
    const profile = this.repository.updateAgentProfile(id, next);
    return { ...profile, hasApiKey: true };
  }

  async delete (id) {
    const deleted = this.repository.deleteAgentProfile(id);
    if (deleted) await this.keychain.delete(id);
    return deleted;
  }
}

module.exports = { AgentManager };
