import ora from 'ora';
import chalk from 'chalk';

/** Stage all files */
export async function stageAllFiles(git) {
    const spinner = ora('📂 Staging all files...').start();
    try {
        await git.add('./*');
        spinner.succeed(' All files staged');
    } catch (err) {
        spinner.fail('Failed to stage files.');
        console.error(chalk.red('Tip: Make sure you have changes to stage and your repository is not empty.'));
        console.error(chalk.cyan('To check status: git status'));
        throw err;
    }
}