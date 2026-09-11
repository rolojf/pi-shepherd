#!/usr/bin/env node
/** Herdr-independent verification of delegated pi launch argument construction. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { writePiLaunchFiles } = await import('../src/core/herdr.ts');
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}`);
  }
}
function check(label, omit, includeOption = true, model, omitContextFiles) {
  const name = label;
  const options = {
    name,
    task: 'do the task',
    systemPrompt: 'agent Markdown body',
    stayOpen: false,
    tools: ['read'],
    omitPiDocumentation: true,
  };
  if (model !== undefined) options.model = model;
  if (omitContextFiles !== undefined) options.omitContextFiles = omitContextFiles;
  if (includeOption) options.omitSystemPrompt = omit;
  let files;
  try {
    files = writePiLaunchFiles(options);
    const script = fs.readFileSync(files.scriptFile, 'utf8');
    const task = fs.readFileSync(`${files.dir}/task-${name}.md`, 'utf8');
    assert(
      script.includes('--append-system-prompt') === false,
      `${label}: no duplicate append system prompt flag`
    );
    assert(
      script.includes("--system-prompt '") === !!omit,
      `${label}: replacement system prompt flag`
    );
    assert(script.includes(`'@${files.dir}/task-${name}.md'`), `${label}: task file argument`);
    assert(
      task.includes('do the task') &&
        task.includes('FINAL assistant message') &&
        task.includes('shepherd_message') &&
        task.includes('shepherd_done') &&
        task.includes('does not complete the task'),
      `${label}: task and completion instructions`
    );
    assert(
      script.includes('shepherd-done.ts') &&
        script.includes("--tools 'read,shepherd_message,shepherd_done'"),
      `${label}: completion extension wiring + child-surface tools kept in --tools allowlist`
    );
    assert(
      script.includes("PI_SHEPHERD_AGENT_SYSTEM_PROMPT_FILE='"),
      `${label}: agent system prompt wiring`
    );
    assert(
      script.includes('PI_SHEPHERD_OMIT_PI_DOCUMENTATION=1'),
      `${label}: Pi documentation omission wiring`
    );
    assert(
      script.includes('--no-context-files') === (omitContextFiles === true),
      `${label}: context-file omission argument`
    );
    assert(
      script.includes("--model 'anthropic/claude-sonnet-4-5'") === (model !== undefined),
      `${label}: model argument`
    );
    assert(fs.existsSync(`${files.dir}/sysprompt-${name}.md`), `${label}: system prompt file`);
    assert(
      fs.readFileSync(`${files.dir}/sysprompt-${name}.md`, 'utf8') === 'agent Markdown body',
      `${label}: prompt file content`
    );
  } finally {
    if (files) fs.rmSync(files.dir, { recursive: true, force: true });
  }
}
check('default', false);
check('implicit-default', false, false);
check('omit', true);
check('context-true', false, true, undefined, true);
check('context-false', false, true, undefined, false);
check('context-absent', false, false);
check('model', false, true, 'anthropic/claude-sonnet-4-5');

const brokerLaunch = writePiLaunchFiles({
  name: 'broker-wired',
  task: 'use the broker',
  childBroker: {
    rootDir: '/tmp/shepherd-broker',
    sessionId: 'session-1',
    brokerId: 'broker-1',
    agentId: 'shepherd-agent-1',
    token: 'secret-token',
    inboxPath: '/tmp/shepherd-broker/agents/child/inbox',
  },
  taskId: 'shepherd-task-1',
});
try {
  const script = fs.readFileSync(brokerLaunch.scriptFile, 'utf8');
  const task = fs.readFileSync(`${brokerLaunch.dir}/task-broker-wired.md`, 'utf8');
  assert(
    task.includes('Task ID: shepherd-task-1') &&
      task.includes('replyTo') &&
      task.includes('status blocked'),
    'broker launch: tracked task context and reply instructions'
  );
  assert(
    script.includes("PI_SHEPHERD_BROKER_DIR='/tmp/shepherd-broker'"),
    'broker launch: broker directory wiring'
  );
  assert(
    script.includes("PI_SHEPHERD_BROKER_SESSION_ID='session-1'"),
    'broker launch: session wiring'
  );
  assert(script.includes("PI_SHEPHERD_BROKER_ID='broker-1'"), 'broker launch: broker id wiring');
  assert(
    script.includes("PI_SHEPHERD_AGENT_ID='shepherd-agent-1'"),
    'broker launch: agent id wiring'
  );
  assert(
    script.includes("PI_SHEPHERD_BROKER_TOKEN='secret-token'"),
    'broker launch: capability wiring'
  );
  assert(
    script.includes("PI_SHEPHERD_AGENT_INBOX='/tmp/shepherd-broker/agents/child/inbox'"),
    'broker launch: inbox wiring'
  );
  assert(script.includes("PI_SHEPHERD_TASK_ID='shepherd-task-1'"), 'broker launch: task id wiring');
} finally {
  fs.rmSync(brokerLaunch.dir, { recursive: true, force: true });
}

const shellSafetyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-shell-safety-'));
const fakeBinDir = path.join(shellSafetyDir, 'bin');
const injectedMarker = path.join(shellSafetyDir, 'injected');
const capturedArgs = path.join(shellSafetyDir, 'pi-args');
const hostileTool = `read; touch '${injectedMarker}' #`;
let hostileLaunch;
try {
  fs.mkdirSync(fakeBinDir);
  fs.writeFileSync(
    path.join(fakeBinDir, 'pi'),
    '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$PI_ARGS_FILE"\n',
    { mode: 0o700 }
  );
  hostileLaunch = writePiLaunchFiles({ name: 'shell-safety', tools: [hostileTool] });

  const result = spawnSync('bash', [hostileLaunch.scriptFile], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      PI_ARGS_FILE: capturedArgs,
    },
  });
  const args = fs.existsSync(capturedArgs) ? fs.readFileSync(capturedArgs, 'utf8').split('\n') : [];
  const toolsIndex = args.indexOf('--tools');

  assert(result.status === 0, 'tool allowlist: launch script completes');
  assert(!fs.existsSync(injectedMarker), 'tool allowlist: shell syntax is not executed');
  assert(
    toolsIndex >= 0 &&
      args[toolsIndex + 1] === `${hostileTool},shepherd_message,shepherd_done`,
    'tool allowlist: Pi receives the complete tool list as one argument'
  );
} finally {
  if (hostileLaunch) fs.rmSync(hostileLaunch.dir, { recursive: true, force: true });
  fs.rmSync(shellSafetyDir, { recursive: true, force: true });
}

// Inheritance is resolved before launch; absent model must omit --model.
if (failures) process.exit(1);
console.log('All launch assertions passed.');
