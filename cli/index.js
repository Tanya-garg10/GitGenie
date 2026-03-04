#!/usr/bin/env node

// ✅ STEP 1 & 5: All static imports at top, no dynamic await import()
import { Command } from 'commander';
import simpleGit from 'simple-git';
import dotenv from 'dotenv';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { execaCommand } from 'execa';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { registerConfigCommand, getActiveProviderInstance } from './commands/config.js';
import { openCommandPalette } from './helpers/commandPalette.js';
import { detectCommitType } from './helpers/detectCommitType.js';
import { displayGeminiError, getDebugModeTip } from './helpers/errorHandler.js';
import {
  analyzeStagedChanges,
  groupFilesWithAI,
  groupFilesHeuristic,
  generateCommitMessageForGroup,
  validateGroups
} from './helpers/splitLogic.js';
import { stageAllFiles } from './helpers/gitUtils.js';
import { registerSplitCommand } from './commands/split.js';
import {
  promptGroupActions,
  promptGroupReview,
  promptMergeGroups,
  confirmCommitAll,
  promptStageChanges,
  promptContinueAfterError,
  showSplitSummary,
  promptDryRun
} from './helpers/splitUI.js';
import {
  handleUndoInteractive,
  handleUndoSoft,
  handleUndoMixed,
  handleUndoBatch,
  handleUndoHard
} from './helpers/undoLogic.js';
import { handleUndoError } from './helpers/undoErrors.js';
import { handleHistoryCommand } from './helpers/historyLogic.js';
import { handleStatusCommand } from './helpers/statusLogic.js';

// ─────────────────────────────────────────────
// Preview mode globals
// ─────────────────────────────────────────────
let isPreviewMode = false;
let previewLogs = [];

dotenv.config({ debug: false });

const realGit = simpleGit();

export const git = new Proxy(realGit, {
  get(target, prop) {
    if (typeof target[prop] !== 'function') {
      return target[prop];
    }
    return async (...args) => {
      if (isPreviewMode) {
        const commandName = String(prop);
        const formattedArgs = args.map(a =>
          typeof a === 'object' ? JSON.stringify(a) : String(a)
        ).join(' ');

        previewLogs.push({
          type: 'git',
          action: commandName,
          args: formattedArgs,
          timestamp: new Date().toISOString()
        });

        console.log(chalk.gray(`  ↳ [preview] git ${commandName} ${formattedArgs}`));
        return Promise.resolve();
      }
      return target[prop](...args);
    };
  }
});

// ─────────────────────────────────────────────
// Banner / Logo
// ─────────────────────────────────────────────
const banner = `
    ${chalk.cyan("🔮")} ${chalk.magentaBright("Git")}${chalk.yellow("Genie")} ${chalk.cyan("🔮")}
    ${chalk.gray("┌─────────────────┐")}
    ${chalk.gray("│")} ${chalk.green("✨ AI-Powered Git ✨")}
    ${chalk.gray("│")} ${chalk.blue("Smart Commit Magic")}
    ${chalk.gray("└─────────────────┘")}
       ${chalk.yellow("⚡")} ${chalk.red("Ready to code!")} ${chalk.yellow("⚡")}
`;
const logo = `
   $$$$$$\\   $$$$$$\\
  $$  __$$\\ $$  __$$\\
  $$ /  \\__|$$ /  \\__|
  $$ |$$$$\\ $$ |$$$$\\
  $$ | \\_$$ $$ | \\_$$|
  $$ |  $$ $$ |  $$|
   $$$$$$  \\$$$$$$  |
    \\______/  \\______/
`;

// ─────────────────────────────────────────────
// Program setup
// ─────────────────────────────────────────────
const program = new Command();

program.configureHelp({
  formatHelp: (cmd, helper) => {
    const options = helper.visibleOptions(cmd)
      .map(opt => `  ${opt.flags}  ${opt.description}`)
      .join('\n');

    const args = helper.visibleArguments(cmd)
      .map(arg => `  <${arg.name}>  ${arg.description || ''}`)
      .join('\n');

    const subcommands = helper.visibleCommands(cmd)
      .map(sub => `  ${sub.name()}  ${sub.description()}`)
      .join('\n');

    const onboarding = `\n${chalk.green.bold(" Welcome to GitGenie!")}
${logo}
${banner}
` +
      chalk.green("Genie powers already unlocked!") +
      '\nTry your first AI-powered commit:\n' +
      chalk.magenta('   gg "your changes" --genie\n') +
      chalk.yellow("⚡ Unlock Genie powers:") +
      '\n   gg config <your_api_key>\n' +
      chalk.cyan("Or just get started with a manual commit:") +
      '\n' + chalk.magenta('   gg "your commit message"\n') +
      chalk.blue("📖 Docs & guide: https://gitgenie.vercel.app/\n");

    return (
      onboarding +
      '\nUsage:\n  ' + helper.commandUsage(cmd) +
      '\n\nDescription:\n  ' + helper.commandDescription(cmd) +
      (options ? '\n\nOptions:\n' + options : '') +
      (args ? '\n\nArguments:\n' + args : '') +
      (subcommands ? '\n\nCommands:\n' + subcommands : '')
    );
  }
});

// ─────────────────────────────────────────────
// Register subcommands
// ─────────────────────────────────────────────
registerConfigCommand(program);
registerSplitCommand(program);

// ─────────────────────────────────────────────
// cl — Clone
// ─────────────────────────────────────────────
program.command('cl')
  .argument('<url>')
  .argument('[dir]')
  .description('Clone repository')
  .action(async (url, dir) => {
    const spinner = ora('📥 Cloning repository...').start();
    try {
      await git.clone(url, dir);

      const repoNameFromUrl = (() => {
        try {
          const parts = url.split('/').filter(Boolean);
          const last = parts[parts.length - 1] || '';
          return (last || 'repo').replace(/\.git$/i, '');
        } catch {
          return dir || 'repo';
        }
      })();

      const targetDir = dir || repoNameFromUrl;
      spinner.succeed(`✅ Repository cloned to "${targetDir}"`);

      console.log(chalk.cyan('Next steps:'));
      console.log(chalk.gray(`  cd ${targetDir}`));
      console.log(chalk.gray('  code .'));

      try {
        await execaCommand('code .', { cwd: path.resolve(process.cwd(), targetDir) });
        console.log(chalk.green(`✅ Opened "${targetDir}" in VS Code`));
      } catch {
        console.log(chalk.yellow('⚠ Could not open VS Code automatically.'));
        console.log(chalk.cyan('Tip: Ensure the "code" command is on your PATH.'));
      }
    } catch (err) {
      spinner.fail('❌ Failed to clone repository.');
      console.log(chalk.red(err.message));
      console.log(chalk.cyan('Tip: Ensure the URL is correct and you have access (SSH/HTTPS).'));
    }
  });

// ─────────────────────────────────────────────
// ignore
// ─────────────────────────────────────────────
program.command('ignore')
  .argument('[pattern]', 'Pattern or template name to ignore')
  .description('Add pattern/template to .gitignore')
  .option('--global', 'Add to global gitignore (~/.gitignore_global)')
  .option('--comment <text>', 'Add comment above the pattern')
  .option('-t, --template', 'Use standard template (e.g. node, python)')
  .option('-l, --list [keyword]', 'List available templates')
  .action(async (pattern, options) => {
    try {
      const { appendToGitignore } = await import('./helpers/gitignoreHelper.js');
      const { TemplateManager } = await import('./helpers/ignoreTemplates.js');
      const manager = new TemplateManager();

      // Mode 1: List templates
      if (options.list !== undefined) {
        const keyword = typeof options.list === 'string' ? options.list : null;
        const templates = manager.listTemplates(keyword);

        console.log(chalk.cyan.bold(`\n📋 ${keyword ? `Templates matching "${keyword}"` : 'Popular Templates'}:`));

        if (templates.length === 0) {
          console.log(chalk.yellow('  No templates found.'));
        } else {
          const { default: Table } = await import('cli-table3');
          const table = new Table({
            head: [],
            chars: {
              'top': '─', 'top-mid': '┬', 'top-left': '╭', 'top-right': '╮',
              'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '╰', 'bottom-right': '╯',
              'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
              'right': '│', 'right-mid': '┤', 'middle': '│'
            },
            colWidths: [18, 18, 18, 18],
            style: { head: [], border: ['gray'] }
          });

          let row = [];
          for (let i = 0; i < templates.length; i++) {
            row.push(chalk.cyan.bold(templates[i]));
            if (row.length === 4) { table.push(row); row = []; }
          }
          if (row.length > 0) {
            while (row.length < 4) row.push('');
            table.push(row);
          }
          console.log(table.toString());
        }
        console.log(chalk.gray(`\n💡 Search: gg ignore --list <keyword>`));
        process.exit(0);
      }

      // Mode 2: Use Template
      if (options.template) {
        if (!pattern) {
          const { default: inquirerCheckboxPlus } = await import('inquirer-checkbox-plus');
          inquirer.registerPrompt('checkbox-plus', inquirerCheckboxPlus);

          console.log(chalk.cyan('Controls: ↑↓ to navigate • space to select • type to filter • enter to submit'));
          const allTemplates = manager.listTemplates().filter(Boolean);
          let debounceTimer;

          const { selected } = await inquirer.prompt([{
            type: 'checkbox-plus',
            name: 'selected',
            message: 'Select templates:',
            pageSize: 10,
            searchable: true,
            source: async (answersSoFar, input) => {
              input = input || '';
              return new Promise((resolve) => {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                  const filtered = input
                    ? allTemplates.filter(t => t.toLowerCase().includes(input.toLowerCase()))
                    : allTemplates;
                  resolve(filtered);
                }, 300);
              });
            }
          }]);

          if (!selected || selected.length === 0) {
            console.log(chalk.yellow('⚠ No templates selected.'));
            process.exit(0);
          }
          pattern = selected.join(',');
        }

        const templateNames = pattern.split(',').map(s => s.trim()).filter(Boolean);
        let combinedContent = '';
        const comment = options.comment ? `# ${options.comment}\n` : '';
        const sources = [];

        const spinner = ora('🔍 Fetching templates...').start();

        for (const name of templateNames) {
          let contentResult = null;
          let finalName = name;

          try {
            contentResult = await manager.getTemplate(name);
          } catch {
            spinner.stop();
            const closest = manager.getClosestMatch(name);

            if (closest) {
              console.log(chalk.yellow(`⚠ Template "${name}" not found.`));
              const { confirm } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirm',
                message: `Did you mean "${closest}"?`,
                default: true
              }]);

              if (confirm) {
                spinner.start(`Fetching corrected template: ${closest}...`);
                try {
                  contentResult = await manager.getTemplate(closest);
                  finalName = closest;
                } catch (fetchErr) {
                  spinner.fail(chalk.red(`Failed to fetch corrected template "${closest}": ${fetchErr.message}`));
                  process.exit(1);
                }
              } else {
                console.log(chalk.red(`❌ Template "${name}" skipped.`));
                continue;
              }
            } else {
              spinner.fail(chalk.red(`❌ Template "${name}" not found.`));
              console.log(chalk.cyan('Run "gg ignore --list" to see available options.'));
              process.exit(1);
            }
          }

          if (contentResult) {
            combinedContent += `\n# Template: ${finalName} (${contentResult.source})\n${contentResult.content}\n`;
            sources.push(`${finalName} (${contentResult.source})`);
          }
        }

        spinner.succeed(`Resolved templates: ${sources.join(', ')}`);

        if (!combinedContent || !combinedContent.trim()) {
          console.log(chalk.yellow('⚠ No templates were selected to add.'));
          process.exit(0);
        }

        const { getGitignorePath } = await import('./helpers/gitignoreHelper.js');
        const filePath = getGitignorePath(options.global);
        fs.appendFileSync(filePath, '\n' + comment + combinedContent, 'utf-8');
        console.log(chalk.green(`✅ Added templates to ${path.basename(filePath)}`));
        process.exit(0);
      }

      // Mode 3: Basic Pattern
      if (!pattern) {
        console.error(chalk.red('⚠ Please specify a pattern or template.'));
        process.exit(1);
      }

      const result = appendToGitignore(pattern, {
        global: options.global || false,
        comment: options.comment || null
      });

      if (result.success) {
        console.log(chalk.green(`✅ ${result.message}`));
        if (options.comment) console.log(chalk.gray(`   Comment: ${options.comment}`));
        console.log(chalk.cyan(`   File: ${result.filePath}`));
      } else {
        console.log(chalk.yellow(`⚠ ${result.message}`));
        process.exit(1);
      }

    } catch (err) {
      console.error(chalk.red('Failed to update .gitignore'));
      console.error(chalk.yellow(err.message));
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────
// history
// ─────────────────────────────────────────────
program
  .command('history')
  .description('Show commit history with filtering and statistics 📊')
  .option('--today', 'Show commits from today only')
  .option('--week', 'Show commits from last 7 days (default)')
  .option('--month', 'Show commits from last 30 days')
  .option('--all', 'Show all commits')
  .option('--author <name>', 'Filter by specific author')
  .option('--since <date>', 'Show commits since date (e.g., "2026-01-20", "3 days ago")')
  .option('--limit <n>', 'Limit number of commits shown', parseInt)
  .action(async (options) => {
    try {
      await handleHistoryCommand(options);
      process.exit(0);
    } catch (err) {
      console.error(chalk.red('Failed to show history.'));
      console.error(chalk.yellow(err.message));
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────
// status
// ─────────────────────────────────────────────
program
  .command('status')
  .alias('st')
  .description('Show visually rich git status with colors and icons 🎨')
  .action(async () => {
    try {
      await handleStatusCommand();
      process.exit(0);
    } catch (err) {
      console.error(chalk.red('Failed to show status.'));
      console.error(chalk.yellow(err.message));
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────
// Branch shortcuts
// ─────────────────────────────────────────────
program.command('b')
  .argument('<branchName>')
  .description('Create & switch to new branch')
  .action(async (branchName) => {
    try {
      await git.checkoutLocalBranch(branchName);
      console.log(chalk.green(`Created & switched to "${branchName}"`));
    } catch (e) {
      console.log(chalk.red(e.message));
    }
  });

program.command('s')
  .argument('<branch>')
  .description('Switch to a branch')
  .action(async (branch) => {
    await git.checkout(branch);
    console.log(chalk.green(`Switched to "${branch}"`));
  });

program.command('wt')
  .argument('<branch>')
  .argument('[dir]')
  .description('Create Git worktree')
  .action(async (branch, dir) => {
    const loc = dir || branch;
    await git.raw(['worktree', 'add', loc, branch]);
    console.log(chalk.green(`Worktree created at "${loc}"`));
  });

// ─────────────────────────────────────────────
// recover
// ─────────────────────────────────────────────
const recoverCmd = program.command('recover')
  .description('Recover lost Git commits, files, or branches safely');

recoverCmd.command('list')
  .description('Show recoverable commits from reflog')
  .option('-n, --count <number>', 'Number of reflog entries to scan', '20')
  .action(async (options) => {
    await handleRecoverList(parseInt(options.count));
  });

recoverCmd.command('explain <n>')
  .description('Explain what happened at reflog entry N')
  .action(async (n) => {
    await handleRecoverExplain(parseInt(n));
  });

recoverCmd.command('apply <n>')
  .description('Apply recovery for reflog entry N')
  .action(async (n) => {
    await handleRecoverApply(parseInt(n));
  });

recoverCmd.action(async () => {
  await handleRecoverInteractive();
});

// ─────────────────────────────────────────────
// undo
// ─────────────────────────────────────────────
const undoCmd = program.command('undo')
  .description('Safely undo recent commits with various reset modes');

undoCmd.command('soft [n]')
  .description('Undo N commits, keep changes staged (default: 1)')
  .action(async (n) => {
    await handleUndoSoft(parseInt(n) || 1);
  });

undoCmd.command('mixed [n]')
  .description('Undo N commits, keep changes unstaged (default: 1)')
  .action(async (n) => {
    await handleUndoMixed(parseInt(n) || 1);
  });

undoCmd.command('hard [n]')
  .description('Discard N commits and all changes (DANGEROUS, default: 1)')
  .action(async (n) => {
    await handleUndoHard(parseInt(n) || 1);
  });

undoCmd.action(async () => {
  await handleUndoInteractive();
});

// ─────────────────────────────────────────────
// commit (named subcommand)
// ─────────────────────────────────────────────
program
  .command('commit <desc>')
  .description('Commit changes with AI & smart options')
  .option('--type <type>', 'Commit type')
  .option('--scope <scope>', 'Commit scope', '')
  .option('--genie', 'AI commit message')
  .option('--osc', 'Open-source branch mode')
  .option('--no-branch', 'Commit on current branch (skip prompt)')
  .option('--push-to-main', 'Merge & push to main')
  .option('--remote <url>', 'Set remote origin')
  .action(async (desc, opts) => {
    await runMainFlow(desc, opts);
  });

// ─────────────────────────────────────────────
// Default (shorthand commit / palette)
// ─────────────────────────────────────────────
program
  .argument('[desc]')
  .option('--type <type>', 'Commit type')
  .option('--scope <scope>', 'Commit scope', '')
  .option('--genie', 'AI mode')
  .option('--osc', 'OSS branch mode')
  .option('--no-branch', 'Skip branch prompt')
  .option('--push-to-main', 'Push to main after commit')
  .option('--remote <url>')
  .action(async (desc, opts) => {
    const first = process.argv[2];
    if (['commit', 'b', 's', 'wt', 'cl', 'config', 'split', 'ignore', 'history', 'status', 'undo', 'recover'].includes(first)) return;
    if (!desc) {
      await openCommandPalette(program);
      process.exit(0);
    }
    await runMainFlow(desc, opts);
  });

// ─────────────────────────────────────────────
// Unknown command handler
// ─────────────────────────────────────────────
program.on('command:*', async (operands) => {
  const command = operands[0];
  const availableCommands = program.commands.map(cmd => cmd.name());

  console.log(chalk.red(`Error: Unknown command "${command}"`));

  const levenshtein = (a, b) => {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
    for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) == a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  };

  let bestMatch = null;
  let minDist = Infinity;
  availableCommands.forEach(cmd => {
    const dist = levenshtein(command, cmd);
    if (dist < minDist && dist <= 3) { minDist = dist; bestMatch = cmd; }
  });

  if (bestMatch) console.log(chalk.yellow(`Did you mean "${chalk.bold(bestMatch)}"?`));
  process.exit(1);
});

program.exitOverride();

// ─────────────────────────────────────────────
// ✅ STEP 3: Async IIFE — replaces top-level await + program.parse()
// ─────────────────────────────────────────────
(async () => {
  try {
    // Preview mode flag
    if (process.argv.includes('--preview')) {
      isPreviewMode = true;
      process.argv = process.argv.filter(arg => arg !== '--preview');
      console.log(chalk.yellow('\n🔍 Running in PREVIEW mode (no Git commands will execute)\n'));
    }

    // No-args → open palette
    if (!process.argv.slice(2).length) {
      await openCommandPalette(program);
      process.exit(0);
    }

    await program.parseAsync(process.argv);

    // Print preview summary after successful parse
    if (isPreviewMode && previewLogs.length > 0) {
      console.log(chalk.cyan('\n📋 Preview Summary:\n'));
      previewLogs.forEach((log, index) => {
        console.log(`${index + 1}. [${log.action}] ${log.args}`);
      });
      console.log(chalk.yellow('\n✅ No changes were made to your repository.\n'));
    }

  } catch (err) {
    if (err.code === 'commander.helpDisplayed') { process.exit(0); }
    if (err.code === 'commander.unknownOption' || err.code === 'commander.unknownCommand') {
      console.error(chalk.red('❌ Unknown command or option'));
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  }
})();

// ─────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────

async function getActiveProvider() {
  try {
    const { getActiveProvider: _get } = await import('./commands/config.js');
    return _get();
  } catch {
    return null;
  }
}

async function generateCommitMessage(diff, opts, desc) {
  const provider = await getActiveProviderInstance();
  const providerName = await getActiveProvider();

  if (!opts.genie || !provider) {
    if (opts.genie && !provider) {
      console.warn(chalk.yellow('⚠ AI provider not configured. Falling back to manual commit message.'));
      console.warn(chalk.cyan('To enable AI commit messages, configure an API key:'));
      console.warn(chalk.gray('Example: gg config <your_api_key> --provider gemini'));
    }
    return `${opts.type}${opts.scope ? `(${opts.scope})` : ''}: ${desc}`;
  }

  const spinner = ora(`🧞 Generating commit message with ${provider.getName()}...`).start();
  try {
    const message = await provider.generateCommitMessage(diff, opts, desc);
    spinner.succeed(` Commit message generated by ${provider.getName()}`);
    return message;
  } catch (err) {
    spinner.fail('AI commit message generation failed. Using manual message instead.');
    const { displayProviderError } = await import('./helpers/errorHandler.js');
    displayProviderError(err, providerName || 'gemini', 'commit message');
    return `${opts.type}${opts.scope ? `(${opts.scope})` : ''}: ${desc}`;
  }
}

async function generatePRTitle(diff, opts, desc) {
  const provider = await getActiveProviderInstance();
  const providerName = await getActiveProvider();

  if (!opts.genie || !provider) {
    if (opts.genie && !provider) {
      console.warn(chalk.yellow('⚠ AI provider not configured. Falling back to manual PR title.'));
    }
    return `${opts.type}${opts.scope ? `(${opts.scope})` : ''}: ${desc}`;
  }

  const spinner = ora(`🧞 Generating PR title with ${provider.getName()}...`).start();
  try {
    const title = await provider.generatePRTitle(diff, opts, desc);
    spinner.succeed(` PR title generated by ${provider.getName()}`);
    return title;
  } catch (err) {
    spinner.fail('AI PR title generation failed.');
    const { displayProviderError } = await import('./helpers/errorHandler.js');
    displayProviderError(err, providerName || 'gemini', 'PR title');
    return `${opts.type}${opts.scope ? `(${opts.scope})` : ''}: ${desc}`;
  }
}

async function generateBranchName(diff, opts, desc) {
  const provider = await getActiveProviderInstance();
  const providerName = await getActiveProvider();

  if (!opts.genie || !provider) {
    return `feature/${desc.toLowerCase().replace(/\s+/g, '-')}`;
  }

  const spinner = ora(`🧞 Generating branch name with ${provider.getName()}...`).start();
  try {
    const branchName = await provider.generateBranchName(desc, opts);
    spinner.succeed(` Branch name generated by ${provider.getName()}`);
    return branchName;
  } catch (err) {
    spinner.fail('AI branch name generation failed.');
    const { displayProviderError } = await import('./helpers/errorHandler.js');
    displayProviderError(err, providerName || 'unknown provider', 'branch name');
    return `feature/${desc.toLowerCase().replace(/\s+/g, '-')}`;
  }
}

async function pushBranch(branchName) {
  const spinner = ora(`🚀 Pushing branch "${branchName}"...`).start();
  const maxRetries = 2;
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      await git.push(['-u', 'origin', branchName]);
      spinner.succeed(`Successfully pushed branch "${branchName}"`);
      return;
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) {
        spinner.fail(`Failed to push branch "${branchName}" after ${maxRetries + 1} attempts.`);
        console.error(chalk.red('Tip: Check your remote URL and network connection.'));
        console.error(chalk.cyan('To set remote: git remote add origin <url>'));
        throw err;
      } else {
        spinner.warn(`Push failed. Retrying... (${attempt}/${maxRetries})`);
      }
    }
  }
}

async function ensureRemoteOriginInteractive() {
  try {
    const remotes = await git.getRemotes(true);
    const hasOrigin = remotes.some(r => r.name === 'origin');
    if (hasOrigin) return true;

    console.log(chalk.yellow('\nℹ️  No remote repository configured.'));
    console.log(chalk.gray('Your commits are only saved locally until you add a remote.\n'));
    const { wantRemote } = await inquirer.prompt([{
      type: 'confirm',
      name: 'wantRemote',
      message: 'Would you like to add a remote origin now?',
      default: true
    }]);

    if (!wantRemote) return false;

    const { remoteUrl } = await inquirer.prompt([{
      type: 'input',
      name: 'remoteUrl',
      message: 'Enter remote origin URL (e.g. https://github.com/user/repo.git):',
      validate: (v) => (v && (v.startsWith('http') || v.startsWith('git@'))) ? true : 'Please enter a valid Git remote URL'
    }]);

    try {
      await git.remote(['add', 'origin', remoteUrl]);
      console.log(chalk.green(`✅ Remote origin set to ${remoteUrl}`));
      return true;
    } catch {
      console.log(chalk.red('❌ Failed to add remote origin.'));
      return false;
    }
  } catch {
    return false;
  }
}

async function mergeToMainAndPush(currentBranch) {
  try {
    console.log(chalk.blue(`ℹ Starting merge process from "${currentBranch}" to main...`));

    const spinner1 = ora('🔄 Switching to main branch...').start();
    await git.checkout('main');
    spinner1.succeed('Switched to main branch');

    const spinner2 = ora('📥 Pulling latest changes from main...').start();
    try {
      await git.pull('origin', 'main');
      spinner2.succeed('Main branch updated');
    } catch {
      spinner2.warn('Could not pull latest changes. Main might not exist on remote yet.');
    }

    const spinner3 = ora(`🔀 Merging "${currentBranch}" into main...`).start();
    await git.merge([currentBranch]);
    spinner3.succeed(`Successfully merged "${currentBranch}" into main`);

    const hasRemote = await ensureRemoteOriginInteractive();
    const spinner4 = ora('🚀 Pushing main branch to remote...').start();
    if (!hasRemote) {
      spinner4.warn('No remote configured. Skipping push of main.');
    } else {
      await git.push(['-u', 'origin', 'main']);
      spinner4.succeed('Successfully pushed main branch');
    }

    const { cleanupBranch } = await inquirer.prompt([{
      type: 'confirm',
      name: 'cleanupBranch',
      message: `Do you want to delete the feature branch "${currentBranch}"?`,
      default: true
    }]);

    if (cleanupBranch && currentBranch !== 'main') {
      const spinner5 = ora(`🧹 Cleaning up feature branch "${currentBranch}"...`).start();
      try {
        await git.deleteLocalBranch(currentBranch);
        spinner5.succeed(`Deleted local branch "${currentBranch}"`);
        try {
          await git.push('origin', `:${currentBranch}`);
          console.log(chalk.green(`Deleted remote branch "${currentBranch}"`));
        } catch {
          console.log(chalk.yellow(`Remote branch "${currentBranch}" may not exist.`));
        }
      } catch {
        spinner5.fail(`Failed to delete branch "${currentBranch}".`);
      }
    }

    console.log(chalk.green('🎉 Successfully merged to main and pushed!'));
  } catch (err) {
    console.error(chalk.red('Merge process failed: ' + err.message));
    throw err;
  }
}

// ─────────────────────────────────────────────
// ✅ STEP 4: stageAllFiles wired with preview support
// ─────────────────────────────────────────────
async function runMainFlow(desc, opts) {
  try {
    let isRepo = await git.checkIsRepo();
    if (!isRepo) {
      console.log(chalk.blue('No git repository found. Initializing...'));
      await git.init();
      console.log(chalk.green('Git repository initialized.'));
    }

    if (opts.remote) {
      try {
        await git.remote(['add', 'origin', opts.remote]);
        console.log(chalk.green(`Remote origin set to ${opts.remote}`));
      } catch {
        console.log(chalk.yellow('Remote origin may already exist.'));
      }
    }

    let hasCommits = true;
    try {
      await git.revparse(['--verify', 'HEAD']);
    } catch {
      hasCommits = false;
    }

    const branchInfo = await git.branch();
    if (branchInfo.detached) {
      console.log(chalk.yellow('\n⚠️  You\'re currently in a detached HEAD state.'));
      console.log(chalk.yellow('Changes made here won\'t belong to any branch.'));
      console.log(chalk.cyan('To continue safely, create a branch:'));
      console.log(chalk.gray('  git switch -c <new-branch-name>\n'));
    }

    let branchName = 'main';
    const currentBranch = branchInfo.current || 'main';

    if (opts.branch == false || !hasCommits) {
      branchName = 'main';
      await git.checkout(['-B', branchName]);
      console.log(chalk.green(`Committing directly to branch: ${branchName}`));
    } else {
      const { branchChoice } = await inquirer.prompt([{
        type: 'list',
        name: 'branchChoice',
        message: `Current branch is "${currentBranch}". Where do you want to commit?`,
        choices: [
          { name: `Commit to current branch (${currentBranch})`, value: 'current' },
          { name: 'Create a new branch', value: 'new' },
        ]
      }]);

      if (branchChoice === 'new') {
        let suggestedBranch;
        let shortTitle = desc;

        if (opts.osc) {
          const { issueNumber } = await inquirer.prompt([{
            type: 'input',
            name: 'issueNumber',
            message: 'Enter issue number (e.g. 123):',
            validate: input => /^\d+$/.test(input) ? true : 'Issue number must be numeric'
          }]);

          if (opts.genie) {
            const unstagedDiff = await git.diff() || desc;
            shortTitle = await generateBranchName(unstagedDiff, opts, desc);
            if (shortTitle.includes('/')) shortTitle = shortTitle.split('/')[1];
          } else {
            shortTitle = desc.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
          }
          suggestedBranch = `${opts.type}/#${issueNumber}-${shortTitle}`;
        } else {
          if (opts.genie) {
            const unstagedDiff = await git.diff() || desc;
            suggestedBranch = await generateBranchName(unstagedDiff, opts, desc);
          } else {
            suggestedBranch = `${opts.type}/${desc.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}`;
          }
        }

        const { newBranchName } = await inquirer.prompt([{
          type: 'input',
          name: 'newBranchName',
          message: 'Enter new branch name:',
          default: suggestedBranch,
          validate: input => input ? true : 'Branch name cannot be empty'
        }]);

        branchName = newBranchName;
        await git.checkoutLocalBranch(branchName);
        console.log(chalk.blue(`Created and switched to new branch: ${branchName}`));
      } else {
        branchName = currentBranch;
        await git.checkout(branchName);
        console.log(chalk.blue(`Committing to current branch: ${branchName}`));
      }
    }

    // Stage files — ✅ STEP 4: preview wired
    let diff = await git.diff(['--cached']);
    if (!diff) {
      const unstagedDiff = await git.diff();
      if (unstagedDiff) {
        console.log(chalk.yellow('\n⚠️  You have modified files, but nothing is staged yet.'));
        console.log(chalk.cyan('Run git add <file> or git add . to stage your changes before committing.\n'));
      } else {
        console.log(chalk.yellow('\n⚠️  No file changes detected.'));
        process.exit(1);
      }

      console.log(chalk.blue('Staging all files...'));
      await stageAllFiles({ preview: isPreviewMode, previewLogger: (msg) => previewLogs.push(msg) });
      diff = await git.diff(['--cached']);
      if (!diff) {
        console.error(chalk.red('\n❌ No file changes detected.'));
        process.exit(1);
      }
    }

    if (!opts.type && !opts.genie) {
      opts.type = await detectCommitType();
      console.log(`🧠 Auto-detected commit type: ${opts.type}`);
    }

    const commitMessage = await generateCommitMessage(diff, opts, desc);
    await git.commit(commitMessage);
    console.log(chalk.green(`Committed changes with message: "${commitMessage}"`));

    if (opts.pushToMain) {
      if (branchName === 'main') {
        const hasRemote = await ensureRemoteOriginInteractive();
        if (!hasRemote) {
          console.log(chalk.yellow('⚠ No remote configured. Skipping push.'));
        } else {
          const spinner = ora(`🚀 Pushing main branch...`).start();
          try {
            await git.push(['-u', 'origin', 'main']);
            spinner.succeed(`✅ Pushed main successfully`);
          } catch (err) {
            spinner.fail(`❌ Failed to push main`);
            throw err;
          }
        }
      } else {
        await mergeToMainAndPush(branchName);
      }
    } else {
      const { confirmPush } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmPush',
        message: `Do you want to push branch "${branchName}" to remote?`,
        default: true
      }]);

      if (confirmPush) {
        const hasRemote = await ensureRemoteOriginInteractive();
        if (!hasRemote) {
          console.log(chalk.yellow('⚠ Skipping push because no remote is configured.'));
        } else {
          await pushBranch(branchName);
        }

        if (branchName !== 'main') {
          const { mergeToMain } = await inquirer.prompt([{
            type: 'confirm',
            name: 'mergeToMain',
            message: `Do you want to merge "${branchName}" to main branch and push?`,
            default: false
          }]);
          if (mergeToMain) await mergeToMainAndPush(branchName);
        }
      } else {
        console.log(chalk.yellow('Push skipped.'));
        console.log(chalk.cyan(`To push manually: git push origin ${branchName}`));
      }
    }

  } catch (err) {
    console.error(chalk.red('Error: ' + err.message));
    console.error(chalk.yellow('Tip: Review the error above and try the suggested command.'));
    console.error(chalk.cyan('To get help: gg --help'));
    process.exit(1);
  }
}

// ─────────────────────────────────────────────
// Recovery handlers
// ─────────────────────────────────────────────
async function handleRecoverList(count) {
  try {
    console.log(chalk.blue('🔍 Scanning reflog for recovery options...'));
    const entries = await parseReflog(count);
    if (entries.length === 0) { formatNoRecoveryOptions(); return; }

    console.log(chalk.green(`\n📋 Found ${entries.length} reflog entries:\n`));
    entries.forEach((entry, index) => {
      const num = chalk.cyan(`${index + 1}.`);
      const hash = chalk.yellow(entry.hash);
      const action = chalk.magenta(entry.action);
      const time = chalk.gray(entry.timestamp);
      const msg = entry.message.substring(0, 60) + (entry.message.length > 60 ? '...' : '');
      console.log(`${num} ${hash} ${action} ${time}`);
      console.log(`   ${chalk.white(msg)}\n`);
    });

    console.log(chalk.cyan('💡 Use "gg recover explain <n>" to see details'));
    console.log(chalk.cyan('💡 Use "gg recover apply <n>" to recover'));
  } catch (error) {
    handleRecoveryError(error);
  }
}

async function handleRecoverExplain(n) {
  try {
    const entries = await parseReflog(50);
    validateReflogIndex(n, entries.length);
    const entry = entries[n - 1];
    const commitInfo = await getCommitInfo(entry.fullHash);

    console.log(chalk.blue('\n📖 Recovery Analysis\n'));
    console.log(`${chalk.cyan('Entry:')} #${n}`);
    console.log(`${chalk.cyan('Commit:')} ${commitInfo.hash} (${commitInfo.fullHash})`);
    console.log(`${chalk.cyan('Action:')} ${entry.action}`);
    console.log(`${chalk.cyan('When:')} ${entry.timestamp}`);
    console.log(`${chalk.cyan('Author:')} ${commitInfo.author} <${commitInfo.email}>`);
    console.log(`${chalk.cyan('Date:')} ${commitInfo.date}`);
    console.log(`${chalk.cyan('Message:')} ${commitInfo.subject}`);

    if (commitInfo.files.length > 0) {
      console.log(`${chalk.cyan('Files:')} ${commitInfo.files.length} files changed`);
      commitInfo.files.slice(0, 10).forEach(file => console.log(`  ${chalk.gray('•')} ${file}`));
      if (commitInfo.files.length > 10) {
        console.log(`  ${chalk.gray('... and')} ${commitInfo.files.length - 10} ${chalk.gray('more files')}`);
      }
    }

    console.log(chalk.yellow('\n⚠️  What this means:'));
    if (entry.action === 'reset') {
      console.log(chalk.gray('This commit was lost due to a git reset operation.'));
    } else if (entry.action === 'rebase') {
      console.log(chalk.gray('This commit was modified/lost during a rebase operation.'));
    } else {
      console.log(chalk.gray('This represents a state change in your repository.'));
    }
    console.log(chalk.cyan('\n💡 To recover: gg recover apply ' + n));
  } catch (error) {
    handleRecoveryError(error);
  }
}

async function handleRecoverApply(n) {
  try {
    const entries = await parseReflog(50);
    validateReflogIndex(n, entries.length);
    const entry = entries[n - 1];
    const commitInfo = await getCommitInfo(entry.fullHash);

    console.log(chalk.blue('\n🔄 Recovery Application\n'));
    console.log(`Recovering: ${chalk.yellow(commitInfo.hash)} - ${commitInfo.subject}`);

    const confirmed = await confirmRecoveryAction(
      'safe',
      `Create recovery branch from commit ${commitInfo.hash}`,
      [
        'Create a new branch with the recovered commit',
        'Your current branch will remain unchanged',
        'No existing work will be lost'
      ]
    );

    if (!confirmed) { console.log(chalk.yellow('Recovery cancelled.')); return; }

    const branchName = await createRecoveryBranch(entry.fullHash);
    console.log(chalk.green('\n🎉 Recovery completed successfully!\n'));
    console.log(chalk.cyan('Next steps:'));
    console.log(chalk.gray(`  git checkout ${branchName}`));
    console.log(chalk.gray(`  git log --oneline -5`));
    console.log(chalk.gray(`  git checkout main`));
    console.log(chalk.gray(`  git merge ${branchName}`));
  } catch (error) {
    handleRecoveryError(error);
  }
}

async function handleRecoverInteractive() {
  try {
    console.log(chalk.blue('🔮 Git Recovery Assistant\n'));
    const entries = await parseReflog(20);
    if (entries.length === 0) { formatNoRecoveryOptions(); return; }

    console.log(chalk.green('Found potential recovery options:\n'));
    entries.slice(0, 5).forEach((entry, index) => {
      const msg = entry.message.substring(0, 50) + (entry.message.length > 50 ? '...' : '');
      console.log(`${chalk.cyan(`${index + 1}.`)} ${chalk.yellow(entry.hash)} ${chalk.gray(entry.timestamp)} - ${msg}`);
    });

    console.log(chalk.gray('\nMore options available with "gg recover list"\n'));

    const { choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: 'What would you like to do?',
      choices: [
        { name: 'Explain a specific entry', value: 'explain' },
        { name: 'Recover a specific entry', value: 'apply' },
        { name: 'Show all entries', value: 'list' },
        { name: 'Exit', value: 'exit' }
      ]
    }]);

    if (choice === 'exit') { console.log(chalk.gray('Recovery assistant closed.')); return; }
    if (choice === 'list') { await handleRecoverList(50); return; }

    const { entryNumber } = await inquirer.prompt([{
      type: 'input',
      name: 'entryNumber',
      message: 'Enter entry number:',
      validate: (input) => {
        const num = parseInt(input);
        return (!isNaN(num) && num >= 1 && num <= entries.length) ? true : `Please enter a number between 1 and ${entries.length}`;
      }
    }]);

    const n = parseInt(entryNumber);
    if (choice === 'explain') await handleRecoverExplain(n);
    else if (choice === 'apply') await handleRecoverApply(n);

  } catch (error) {
    handleRecoveryError(error);
  }
}
// test split feature