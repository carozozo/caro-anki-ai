const AGENT_LANGUAGES = Object.freeze([
  { value: 'de', label: 'German', promptName: 'German' },
  { value: 'en', label: 'English', promptName: 'English' },
  { value: 'es', label: 'Spanish', promptName: 'Spanish' },
  { value: 'fr', label: 'French', promptName: 'French' },
  { value: 'ja', label: 'Japanese', promptName: 'Japanese' },
  { value: 'ko', label: 'Korean', promptName: 'Korean' },
  { value: 'zh-CN', label: 'Simplified Chinese', promptName: 'Simplified Chinese' },
  { value: 'zh-TW', label: 'Traditional Chinese', promptName: 'Traditional Chinese (Taiwan)' },
]);

const DEFAULT_AGENT_LANGUAGE = 'en';
const languageEntry = language => AGENT_LANGUAGES.find(entry => entry.value === language)
  || AGENT_LANGUAGES.find(entry => entry.value === DEFAULT_AGENT_LANGUAGE);
const isAgentLanguage = language => AGENT_LANGUAGES.some(entry => entry.value === language);
const agentLanguagePrompt = language => {
  const { value, promptName } = languageEntry(language);
  return [
    `The user's selected default language is ${promptName} (${value}).`,
    `Use ${promptName} for chat replies and for prose you author in instructions, skills, and memories.`,
    'A direct user request to use another language takes precedence. Preserve code, identifiers, and quoted text',
    'unless the user asks to translate them.',
  ].join(' ');
};
const agentLanguageOptions = () => AGENT_LANGUAGES.map(({ value, label }) => ({ value, label }));

module.exports = {
  AGENT_LANGUAGES, DEFAULT_AGENT_LANGUAGE, agentLanguageOptions, agentLanguagePrompt, isAgentLanguage,
};
