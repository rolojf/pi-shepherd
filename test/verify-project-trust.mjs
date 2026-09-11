#!/usr/bin/env node
/** Regression coverage for Pi project-trust propagation and fail-closed discovery. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTheme } from '@earendil-works/pi-coding-agent';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-project-trust-'));
const agentDir = path.join(home, '.pi', 'agent');
const trustedProject = path.join(home, 'trusted-project');
const unrelatedProject = path.join(home, 'unrelated-project');
for (const directory of [agentDir, trustedProject, unrelatedProject])
  fs.mkdirSync(directory, { recursive: true });

process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;

const projectAgent = `---\nname: project-only\ndescription: Repository-controlled project agent\ntools: read\n---\nProject agent body.\n`;
const unrelatedAgent = `---\nname: unrelated-only\ndescription: Agent from another project\ntools: read\n---\nUnrelated agent body.\n`;
fs.mkdirSync(path.join(trustedProject, '.pi', 'agents'), { recursive: true });
fs.mkdirSync(path.join(unrelatedProject, '.pi', 'agents'), { recursive: true });
fs.writeFileSync(path.join(trustedProject, '.pi', 'agents', 'project-only.md'), projectAgent);
fs.writeFileSync(path.join(unrelatedProject, '.pi', 'agents', 'unrelated-only.md'), unrelatedAgent);
fs.mkdirSync(path.join(trustedProject, '.shepherd'), { recursive: true });
fs.mkdirSync(path.join(unrelatedProject, '.shepherd'), { recursive: true });
fs.writeFileSync(
  path.join(trustedProject, '.shepherd', 'config.json'),
  JSON.stringify({
    projectScope: true,
    agentScope: 'project',
    includeBundledAgents: false,
    fieldnotes: true,
    timeout: 33,
    confirmProjectAgents: false,
  })
);
fs.writeFileSync(
  path.join(unrelatedProject, '.shepherd', 'config.json'),
  JSON.stringify({
    projectScope: true,
    agentScope: 'project',
    includeBundledAgents: false,
  })
);
fs.mkdirSync(path.join(agentDir, 'pi-shepherd'), { recursive: true });
fs.writeFileSync(
  path.join(agentDir, 'pi-shepherd', 'config.json'),
  JSON.stringify({
    agentScope: 'both',
    includeBundledAgents: false,
    fieldnotes: false,
    timeout: 7,
    confirmProjectAgents: true,
  })
);

const suffix = Date.now();
const previousShepherdSession = process.env.PI_SHEPHERD_SESSION;
delete process.env.PI_SHEPHERD_SESSION;
const config = await import(`../src/extension/config.ts?project-trust=${suffix}`);
const discovery = await import(`../src/core/discovery.ts?project-trust=${suffix}`);
const lifecycle = await import(`../src/core/lifecycle.ts?project-trust=${suffix}`);
const shepherd = await import(`../src/extension/shepherd.ts?project-trust=${suffix}`);
const settingsUi = await import(`../src/extension/settings-ui.ts?project-trust=${suffix}`);
const resolver = await import(`../scripts/resolve-agent.mjs?project-trust=${suffix}`);

const {
  fieldnotesEnabled,
  initializeSessionSettings,
  loadProjectFileValues,
  loadSettings,
} = config;
const { discoverAgents } = discovery;
const { startAgent } = lifecycle;
const { doAction } = shepherd;
const { openSettings } = settingsUi;

function assertNotRead(file, action, label) {
  const oldAccessMs = Date.now() - 86_400_000;
  fs.utimesSync(file, oldAccessMs / 1_000, oldAccessMs / 1_000);
  action();
  const accessMs = fs.statSync(file).atimeMs;
  assert.ok(accessMs < oldAccessMs + 10_000, label);
}

const trustedConfigPath = path.join(trustedProject, '.shepherd', 'config.json');
const trustedAgentPath = path.join(trustedProject, '.pi', 'agents', 'project-only.md');
const unrelatedAgentPath = path.join(unrelatedProject, '.pi', 'agents', 'unrelated-only.md');

// Missing/false trust must not activate or even inspect project-owned state.
let untrustedSettings;
assertNotRead(
  trustedConfigPath,
  () => {
    untrustedSettings = loadSettings(trustedProject, false);
  },
  'untrusted settings does not read project config'
);
assert.equal(untrustedSettings.projectScope, false, 'untrusted config remains inactive');
assert.equal(untrustedSettings.agentScope, 'both', 'untrusted config falls back to user settings');
assert.equal(untrustedSettings.timeout, 7, 'untrusted config cannot override user settings');
let missingTrustSettings;
assertNotRead(
  trustedConfigPath,
  () => {
    missingTrustSettings = loadSettings(trustedProject);
  },
  'missing trust does not read project config'
);
assert.equal(missingTrustSettings.projectScope, false, 'missing trust fails closed');
let untrustedProjectValues;
assertNotRead(
  trustedConfigPath,
  () => {
    untrustedProjectValues = loadProjectFileValues(trustedProject, false);
  },
  'parked project values do not read config without trust'
);
assert.equal(untrustedProjectValues.timeout, 20, 'parked project values use built-in defaults');
assert.equal(
  loadSettings(trustedProject, true).projectScope,
  true,
  'trusted config activates for the current project'
);
assert.equal(loadSettings(trustedProject, true).timeout, 33, 'trusted project timeout applies');

let untrustedDiscovery;
assertNotRead(
  trustedAgentPath,
  () => {
    untrustedDiscovery = discoverAgents(trustedProject, 'both', {
      includeBundled: false,
      projectTrusted: false,
    });
  },
  'untrusted discovery does not read project agent files'
);
assert.ok(
  !untrustedDiscovery.agents.some(agent => agent.name === 'project-only'),
  'untrusted discovery excludes project definitions'
);
assert.deepEqual(untrustedDiscovery.projectDirs, [], 'untrusted discovery does not expose project dirs');
let missingTrustDiscovery;
assertNotRead(
  trustedAgentPath,
  () => {
    missingTrustDiscovery = discoverAgents(trustedProject, 'project', {
      includeBundled: false,
    });
  },
  'missing discovery trust does not read project agents'
);
assert.ok(
  !missingTrustDiscovery.agents.some(agent => agent.name === 'project-only'),
  'discovery with missing trust fails closed'
);
assert.ok(
  discoverAgents(trustedProject, 'project', { includeBundled: false, projectTrusted: true }).agents.some(
    agent => agent.name === 'project-only'
  ),
  'trusted discovery includes project definitions'
);

const baseContext = {
  cwd: trustedProject,
  model: { provider: 'test', id: 'model' },
  sessionId: `project-trust-${suffix}`,
};
const untrustedAction = await doAction(
  { action: 'agents', agentScope: 'both' },
  { ...baseContext, isProjectTrusted: () => false }
);
assert.ok(
  !untrustedAction.details.agents.some(agent => agent.name === 'project-only'),
  'tool adapter does not list untrusted project agents'
);
const unknownTrustAction = await doAction(
  { action: 'agents', agentScope: 'both' },
  baseContext
);
assert.ok(
  !unknownTrustAction.details.agents.some(agent => agent.name === 'project-only'),
  'tool adapter with unavailable trust fails closed'
);
const trustedAction = await doAction(
  { action: 'agents', agentScope: 'project' },
  { ...baseContext, isProjectTrusted: () => true }
);
assert.ok(
  trustedAction.details.agents.some(agent => agent.name === 'project-only'),
  'trusted tool adapter discovers project agents'
);

// Confirmation is required before Herdr startup; no UI/confirm API must reject.
await assert.rejects(
  startAgent('project-only', {}, { ...baseContext, hasUI: false, isProjectTrusted: () => true }),
  /confirm|approval|UI/i,
  'trusted project spawn rejects when no confirmation UI is available'
);
await assert.rejects(
  startAgent('project-only', {}, { ...baseContext, hasUI: true, ui: {}, isProjectTrusted: () => true }),
  /confirm|approval|UI/i,
  'trusted project spawn rejects when confirmation API is unavailable'
);
let confirmationCalls = 0;
await assert.rejects(
  startAgent(
    'project-only',
    {},
    {
      ...baseContext,
      hasUI: true,
      ui: {
        async confirm() {
          confirmationCalls++;
          return false;
        },
      },
      isProjectTrusted: () => true,
    }
  ),
  /not approved/i,
  'trusted project spawn honors a declined confirmation'
);
assert.equal(confirmationCalls, 1, 'trusted project spawn prompts once before runtime startup');
await assert.rejects(
  startAgent('project-only', {}, { ...baseContext, hasUI: false, isProjectTrusted: () => false }),
  /Unknown agent/i,
  'untrusted project spawn cannot resolve a project definition'
);
await assert.rejects(
  startAgent(
    'unrelated-only',
    { cwd: unrelatedProject },
    { ...baseContext, hasUI: false, isProjectTrusted: () => true }
  ),
  /Unknown agent/i,
  'current-project trust does not authorize an unrelated spawn cwd'
);

initializeSessionSettings(trustedProject, false);
assert.equal(fieldnotesEnabled(), false, 'untrusted startup uses user fieldnotes settings');
initializeSessionSettings(trustedProject, true);
assert.equal(fieldnotesEnabled(), true, 'trusted startup may use project fieldnotes settings');

// Exercise the real slash-command adapter: startup trust feeds completions and agents listing.
const commands = new Map();
const events = [];
const pi = {
  registerTool() {},
  registerMessageRenderer() {},
  registerCommand(name, spec) {
    commands.set(name, spec);
  },
  on(event, handler) {
    events.push({ event, handler });
  },
};
const { default: extension } = await import(`../index.ts?project-trust=${suffix}`);
extension(pi);
const sessionStart = events.find(entry => entry.event === 'session_start');
assert.ok(sessionStart, 'startup adapter registered a session_start hook');
const notifications = [];
const commandContext = {
  ...baseContext,
  hasUI: true,
  isProjectTrusted: () => false,
  ui: {
    notify(message, level) {
      notifications.push({ message, level });
    },
    setWidget() {},
  },
  sessionManager: { getSessionId: () => `command-${suffix}` },
};
sessionStart.handler({}, commandContext);
const command = commands.get('shepherd');
assert.ok(command, 'slash-command adapter registered');
assert.ok(
  !(command.getArgumentCompletions('spawn ') ?? []).some(item => item.value.includes('project-only')),
  'untrusted slash completion omits project agents'
);
await command.handler('agents both', commandContext);
assert.ok(
  !notifications.at(-1).message.includes('project-only'),
  'untrusted slash agents action omits project definitions'
);
const trustedNotifications = [];
const trustedCommandContext = {
  ...commandContext,
  isProjectTrusted: () => true,
  ui: {
    notify(message, level) {
      trustedNotifications.push({ message, level });
    },
    setWidget() {},
  },
};
sessionStart.handler({}, trustedCommandContext);
assert.ok(
  (command.getArgumentCompletions('spawn ') ?? []).some(item => item.value.includes('project-only')),
  'trusted slash completion includes project agents'
);
await command.handler('agents project', trustedCommandContext);
assert.ok(
  trustedNotifications.at(-1).message.includes('project-only'),
  'trusted slash agents action lists project definitions'
);

// Settings UI uses the same trust decision: an untrusted project cannot activate or write its file.
initTheme('dark', false);
const configBeforeSettings = fs.readFileSync(trustedConfigPath, 'utf8');
const oldSettingsAccessMs = Date.now() - 86_400_000;
fs.utimesSync(trustedConfigPath, oldSettingsAccessMs / 1_000, oldSettingsAccessMs / 1_000);
let untrustedSettingsComponent;
await openSettings({
  cwd: trustedProject,
  isProjectTrusted: () => false,
  ui: {
    async custom(factory) {
      untrustedSettingsComponent = factory({}, { fg: (_color, text) => text }, {}, () => {});
      untrustedSettingsComponent.handleInput('\r');
    },
    notify() {},
  },
});
const settingsText = untrustedSettingsComponent
  .render(120)
  .join('\n')
  .replace(/\x1b\[[0-9;]*m/g, '');
assert.match(settingsText, /Settings scope\s+user/, 'untrusted settings UI stays on user scope');
assert.ok(
  fs.statSync(trustedConfigPath).atimeMs < oldSettingsAccessMs + 10_000,
  'untrusted settings UI does not read project config'
);
assert.equal(
  fs.readFileSync(trustedConfigPath, 'utf8'),
  configBeforeSettings,
  'untrusted settings UI cannot write project config'
);
const settingsProject = path.join(home, 'settings-project');
fs.mkdirSync(settingsProject, { recursive: true });
await openSettings({
  cwd: settingsProject,
  isProjectTrusted: () => true,
  ui: {
    async custom(factory) {
      const component = factory({}, { fg: (_color, text) => text }, {}, () => {});
      component.handleInput('\r');
    },
    notify() {},
  },
});
assert.equal(
  JSON.parse(fs.readFileSync(path.join(settingsProject, '.shepherd', 'config.json'), 'utf8'))
    .projectScope,
  true,
  'trusted settings UI can activate project config'
);

// The resolver must bind its environment-selected cwd to the Pi session cwd.
function resolveDiagnostic(discoveryCwd, contextCwd, trusted) {
  const output = path.join(home, `resolver-${Math.random().toString(16).slice(2)}.json`);
  process.env.PI_AGENT_DISCOVERY_FILE = output;
  process.env.PI_AGENT_DISCOVERY_CWD = discoveryCwd;
  process.env.PI_AGENT_DISCOVERY_SCOPE = 'project';
  process.env.PI_AGENT_DISCOVERY_NAME =
    discoveryCwd === trustedProject ? 'project-only' : 'unrelated-only';
  let resolverHandler;
  resolver.default({
    on(_event, handler) {
      resolverHandler = handler;
    },
  });
  resolverHandler({}, {
    cwd: contextCwd,
    isProjectTrusted: () => trusted,
    shutdown() {},
  });
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  fs.rmSync(output, { force: true });
  return result;
}
const oldUnrelatedAgentAccessMs = Date.now() - 86_400_000;
fs.utimesSync(
  unrelatedAgentPath,
  oldUnrelatedAgentAccessMs / 1_000,
  oldUnrelatedAgentAccessMs / 1_000
);
const mismatchedResolver = resolveDiagnostic(unrelatedProject, trustedProject, true);
assert.equal(
  mismatchedResolver.ok,
  false,
  'resolver does not reuse trust for a mismatched discovery cwd'
);
assert.ok(
  fs.statSync(unrelatedAgentPath).atimeMs < oldUnrelatedAgentAccessMs + 10_000,
  'mismatched resolver does not read another project agent'
);
const matchingResolver = resolveDiagnostic(trustedProject, trustedProject, true);
assert.equal(matchingResolver.ok, true, 'resolver trusts a matching Pi session cwd');
for (const name of [
  'PI_AGENT_DISCOVERY_FILE',
  'PI_AGENT_DISCOVERY_CWD',
  'PI_AGENT_DISCOVERY_SCOPE',
  'PI_AGENT_DISCOVERY_NAME',
])
  delete process.env[name];

// The extractor must preserve Pi trust resolution rather than forcing --approve.
const fakePi = path.join(home, 'fake-pi.sh');
const extractorArgLog = path.join(home, 'extractor-args.log');
fs.writeFileSync(
  fakePi,
  `#!/bin/sh
printf '%s\\n' BEGIN >> "$PI_EXTRACTOR_ARG_LOG"
for arg in "$@"; do printf '%s\\n' "$arg" >> "$PI_EXTRACTOR_ARG_LOG"; done
printf '%s\\n' END >> "$PI_EXTRACTOR_ARG_LOG"
if [ -n "$PI_AGENT_DISCOVERY_FILE" ]; then
  cat > "$PI_AGENT_DISCOVERY_FILE" <<'JSON'
{"ok":true,"agent":{"name":"project-only","description":"diagnostic","source":"project","filePath":"project-only.md","systemPrompt":"diagnostic body","tools":["read"],"model":"default","omitSystemPrompt":false,"omitPiDocumentation":false,"omitContextFiles":false,"userInvocable":true}}
JSON
elif [ -n "$PI_SYSTEM_PROMPT_CAPTURE_FILE" ]; then
  printf '%s\\n' 'captured diagnostic prompt' > "$PI_SYSTEM_PROMPT_CAPTURE_FILE"
fi
`,
  { mode: 0o700 }
);
const extractor = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    'scripts/extract-pi-system-prompt.mjs',
    'agent',
    'project-only',
    '--scope',
    'project',
    '--cwd',
    trustedProject,
    '--pi',
    fakePi,
    '--timeout',
    '5',
  ],
  {
    cwd: path.resolve('.'),
    env: { ...process.env, PI_EXTRACTOR_ARG_LOG: extractorArgLog },
    encoding: 'utf8',
  }
);
assert.equal(extractor.status, 0, `extractor mock completed: ${extractor.stderr}`);
const extractorInvocations = fs
  .readFileSync(extractorArgLog, 'utf8')
  .split('BEGIN\n')
  .slice(1)
  .map(block => block.split('\nEND\n')[0].split('\n').filter(Boolean));
assert.equal(extractorInvocations.length, 2, 'extractor launched resolver and capture children');
assert.ok(
  extractorInvocations.every(args => !args.includes('--approve')),
  'extractor does not force Pi approval in either child'
);

// The standalone prompt-body diagnostic has no Pi trust context and therefore fails closed.
const diagnostic = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    'scripts/show-shepherd-prompt.mjs',
    'project-only',
    '--scope',
    'project',
    '--cwd',
    trustedProject,
  ],
  { cwd: path.resolve('.'), env: process.env, encoding: 'utf8' }
);
assert.notEqual(diagnostic.status, 0, 'standalone project diagnostic fails without Pi trust');
assert.match(diagnostic.stderr, /Agent not found/, 'diagnostic does not reveal untrusted project agent');

console.log('All project-trust assertions passed.');
if (previousShepherdSession === undefined) delete process.env.PI_SHEPHERD_SESSION;
else process.env.PI_SHEPHERD_SESSION = previousShepherdSession;
fs.rmSync(home, { recursive: true, force: true });
