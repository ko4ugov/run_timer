const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEFAULT_COMMANDS = {
  python: 'python3 -u ${file}',
  javascript: 'node ${file}',
  shellscript: 'bash ${file}',
  ruby: 'ruby ${file}',
  perl: 'perl ${file}',
  go: 'go run ${file}',
};

let output;
let statusItem;
let running = null;

function activate(context) {
  output = vscode.window.createOutputChannel('Run Timer');

  statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusItem.command = 'runTimer.run';
  setIdle();
  statusItem.show();

  context.subscriptions.push(
    output,
    statusItem,
    vscode.commands.registerCommand('runTimer.run', runCurrentFile),
    vscode.commands.registerCommand('runTimer.stop', stopRunning)
  );
}

function setIdle(lastTime) {
  statusItem.text = lastTime
    ? `$(watch) Run Timer: ${lastTime}`
    : '$(watch) Run Timer';
  statusItem.tooltip = 'Запустить текущий файл и измерить время выполнения';
  statusItem.command = 'runTimer.run';
}

function setBusy() {
  statusItem.text = '$(sync~spin) Выполняется... (нажмите, чтобы остановить)';
  statusItem.tooltip = 'Остановить выполнение';
  statusItem.command = 'runTimer.stop';
}

function getCommands() {
  const custom = vscode.workspace
    .getConfiguration('runTimer')
    .get('commands', {});
  return { ...DEFAULT_COMMANDS, ...custom };
}

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(1)} мс`;
  if (ms < 60000) return `${(ms / 1000).toFixed(3)} с`;
  const min = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(1);
  return `${min} мин ${sec} с`;
}

async function runCurrentFile() {
  if (running) {
    vscode.window.showWarningMessage('Код уже выполняется. Остановите его или дождитесь завершения.');
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Откройте файл с кодом.');
    return;
  }

  const doc = editor.document;
  if (doc.isUntitled) {
    vscode.window.showWarningMessage('Сначала сохраните файл на диск.');
    return;
  }
  await doc.save();

  const template = getCommands()[doc.languageId];
  if (!template) {
    vscode.window.showWarningMessage(
      `Язык "${doc.languageId}" не поддерживается. Добавьте команду в настройку runTimer.commands.`
    );
    return;
  }

  const file = doc.fileName;
  const cwd = path.dirname(file);
  const cmd = template.replace(/\$\{file\}/g, shellQuote(file));

  const cfg = vscode.workspace.getConfiguration('runTimer');
  const inputName = cfg.get('inputFile', 'input.txt');
  const inputPath = path.isAbsolute(inputName)
    ? inputName
    : path.join(cwd, inputName);
  const inputFromFile = fs.existsSync(inputPath);
  let inputText = '';

  if (!inputFromFile && cfg.get('askInput', false)) {
    const answer = await vscode.window.showInputBox({
      prompt: 'Входные данные (stdin). Для перевода строки пишите \\n',
      placeHolder: '5\\n1 2 3 4 5',
    });
    if (answer === undefined) return; // нажали Esc: отмена запуска
    inputText = answer.replace(/\\n/g, '\n') + '\n';
  }

  output.clear();
  output.appendLine(`> ${cmd}`);
  output.appendLine('');

  setBusy();
  const start = process.hrtime.bigint();
  let finished = false;

  const child = spawn(cmd, {
    cwd,
    shell: true,
    detached: true,
  });
  running = child;

  child.stdin.on('error', () => {}); // программа могла завершиться, не дочитав ввод
  if (inputFromFile) {
    fs.createReadStream(inputPath).pipe(child.stdin); // поток, большие файлы не грузятся в память
  } else {
    child.stdin.end(inputText); // пустая строка = сразу EOF
  }

  const finish = (code, signal, error) => {
    if (finished) return;
    finished = true;
    running = null;

    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const time = formatDuration(ms);

    output.appendLine('');
    if (error) {
      output.appendLine(`[Ошибка запуска: ${error.message}]`);
    }
    output.appendLine(`[Код возврата: ${code ?? signal}]`);
    output.appendLine(`[Время выполнения: ${time}]`);

    setIdle(time);

    if (error || (code !== 0 && code !== null)) {
      vscode.window.showErrorMessage(`Завершено с ошибкой за ${time} (код: ${code ?? signal})`);
    } else if (signal) {
      vscode.window.showWarningMessage(`Остановлено через ${time}`);
    } else {
      vscode.window.showInformationMessage(`⏱ Время выполнения: ${time}`);
    }
  };

  child.stdout.on('data', (d) => output.append(d.toString()));
  child.stderr.on('data', (d) => output.append(d.toString()));
  child.on('error', (err) => finish(null, null, err));
  child.on('close', (code, signal) => finish(code, signal));
}

function stopRunning() {
  if (!running) return;
  try {
    process.kill(-running.pid, 'SIGTERM');
  } catch (e) {
    running.kill('SIGTERM');
  }
}

function deactivate() {
  stopRunning();
}

module.exports = { activate, deactivate };