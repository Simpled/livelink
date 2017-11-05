import chalk from 'chalk';
import { oneLine } from 'common-tags';
import * as filenamify from 'filenamify';
import * as fs from 'fs-extra';
import * as inquirer from 'inquirer';
import * as path from 'path';
import * as yaml from 'yamljs';
import expandTilde = require('expand-tilde');
import Logger = require('clix-logger');
import tildify = require('tildify');

const logger = Logger({
  appendTime: false,
  coloredOutput: true,
});

main();

/* ============================================================================
 * Interfaces */

interface LiveLinkConfig {
  items: {
    [name: string]: string[];
  };
}

interface LinkGroup {
  name: string;
  syncDir: string;
  links: { [key: string]: string };
}

enum ChoiceOption {
  Skip = 'Skip',
  SkipAll = 'SkipAll',
  Replace = 'Replace',
  ReplaceAll = 'ReplaceAll',
}

/* ============================================================================
 * Main */

async function main() {
  const rootDir = await inquireRootDir();

  const config = loadYamlConfig(rootDir);
  const linkGroups = generateLinkGroups(rootDir, config);

  for (let i = 0; i < linkGroups.length; i++) {
    console.log();
    await processLinks(linkGroups[i]);
  }

  console.log();
}

/* ============================================================================
 * Helpers */

function resolveFullPath(somePath: string) {
  return path.resolve(expandTilde(somePath));
}

function resolveYamlConfigPath(rootDir: string) {
  return resolveFullPath(path.join(rootDir, 'livelink.yml'));
}

function getStat(somePath: string) {
  try {
    return fs.lstatSync(somePath);
  } catch (e) {
    return undefined;
  }
}

function loadYamlConfig(rootDir: string): LiveLinkConfig {
  const yamlPath = resolveYamlConfigPath(rootDir);

  if (!fs.existsSync(yamlPath)) {
    logger.error('No configuration file found at', yamlPath);
    process.exit(1);
  }

  return yaml.load(yamlPath);
}

function generateLinkGroups(rootDir: string, config: LiveLinkConfig) {
  const items: LinkGroup[] = Object.keys(config.items).map(name => {
    const syncDir = resolveFullPath(path.join(rootDir, 'links', name));

    const links = config.items[name].reduce((acc, bakPath) => {
      const resolvedPath = resolveFullPath(bakPath);
      const linkFileName = filenamify(resolvedPath).toLowerCase();

      return {
        ...acc,
        [linkFileName]: resolvedPath,
      };
    }, {});

    return { name, syncDir, links };
  });

  return items;
}

async function processLinks(group: LinkGroup) {
  logger.subtle(`══════ ${group.name} ══════`);

  const linkNames = Object.keys(group.links);

  for (let i = 0; i < linkNames.length; i++) {
    const linkName = linkNames[i];
    const targetPath = group.links[linkName];
    const linkPath = path.join(group.syncDir, linkName);

    logger.subtle(`${linkPath} -> ${targetPath}`);
    await processLink(group.name, linkPath, targetPath);
  }
}

async function processLink(
  linkGroupName: string,
  linkPath: string,
  targetPath: string,
) {
  let skip = false;
  const stat = getStat(linkPath);

  if (stat) {
    // link or copy of data present at link location
    const isLinkSymbolic = stat.isSymbolicLink();

    if (isLinkSymbolic) {
      // link is a symbolic link
      let currentTarget = fs.readlinkSync(linkPath);

      if (!path.isAbsolute(currentTarget)) {
        // link path is relative, resolve it to the absolute target path
        currentTarget = path.resolve(path.dirname(linkPath), currentTarget);
      }

      if (currentTarget === targetPath) {
        // already links to the desired target
        skip = true;
      } else {
        // links to a different target than desired
        const linkAction = await inquireExistingLinkToAnotherTargetAction(
          linkGroupName,
          linkPath,
          currentTarget,
        );

        if (
          linkAction === ChoiceOption.Replace ||
          linkAction === ChoiceOption.ReplaceAll
        ) {
          fs.removeSync(linkPath);
        } else {
          skip = true;
        }
      }
    } else {
      const linkAction = await inquireExistingSyncEntityAction(
        linkGroupName,
        linkPath,
      );

      if (
        linkAction === ChoiceOption.Replace ||
        linkAction === ChoiceOption.ReplaceAll
      ) {
        // we're moving the entity at link location to the target location,
        // then creating a symbolic link in place of it to the target

        if (fs.existsSync(targetPath)) {
          // but, there is already something at the target path

          const targetAction = await inquireExistingTargetEntityAction(
            linkGroupName,
            targetPath,
          );

          if (
            targetAction === ChoiceOption.Replace ||
            targetAction === ChoiceOption.ReplaceAll
          ) {
            fs.renameSync(targetPath, targetPath + '.livelink.original');
          } else {
            skip = true;
          }
        }

        if (!skip) {
          fs.moveSync(linkPath, targetPath);
        }
      } else {
        skip = true;
      }
    }
  }

  if (!skip) {
    await fs.ensureSymlink(targetPath, linkPath);
  }
}

async function inquireRootDir() {
  const answers = await inquirer.prompt({
    name: 'rootDir',
    message: 'Enter your LiveLink sync directory',
    default: tildify(process.cwd()),
    validate: dir => {
      const resolvedRoot = resolveFullPath(dir);
      if (
        !fs.existsSync(resolvedRoot) ||
        !fs.statSync(resolvedRoot).isDirectory()
      ) {
        return `Invalid directory: ${tildify(resolvedRoot)}`;
      }

      const configPath = resolveYamlConfigPath(resolvedRoot);

      if (!fs.existsSync(configPath)) {
        return `No configuration file found at: ${tildify(configPath)}`;
      }

      return true;
    },
  });

  return answers.rootDir;
}

let inquireExistingLinkToAnotherTargetAction = async function(
  linkGroupName: string,
  linkPath: string,
  currentTarget: string,
) {
  const type = fs.statSync(currentTarget).isDirectory() ? 'directory' : 'file';

  printPreQuestionMessage(oneLine`
    There is already a link for ${linkGroupName} in your sync directory,
    but it points to a different ${type}: ${tildify(currentTarget)}`);

  const answers = await inquirer.prompt({
    name: 'choice',
    type: 'list',
    // todo: mm: use either file or directory, smartly
    message: `What would you like to do?`,
    choices: [
      {
        name: 'Skip',
        value: ChoiceOption.Skip,
      },
      {
        name: 'Skip (apply to all)',
        value: ChoiceOption.SkipAll,
      },
      {
        name: 'Replace with link to the new target',
        value: ChoiceOption.Replace,
      },
      {
        name: 'Replace with link to the new target (apply to all)',
        value: ChoiceOption.ReplaceAll,
      },
    ],
  });

  const foreverAnswers = [ChoiceOption.ReplaceAll, ChoiceOption.SkipAll];
  if (foreverAnswers.includes(answers.choice)) {
    inquireExistingLinkToAnotherTargetAction = async () => answers.choice;
  }

  return answers.choice;
};

let inquireExistingSyncEntityAction = async function(
  linkGroupName: string,
  linkPath: string,
) {
  const type = fs.statSync(linkPath).isDirectory() ? 'directory' : 'file';

  printPreQuestionMessage(oneLine`There is already an actual ${type}
    in place of the link for ${linkGroupName} in your sync directory:
    ${tildify(linkPath)}.`);

  const answers = await inquirer.prompt({
    name: 'linkPresentAction',
    type: 'list',
    // todo: mm: use either file or directory, smartly
    message: `What would you like to do?`,
    choices: [
      {
        name: 'Ignore',
        value: ChoiceOption.Skip,
      },
      {
        name: 'Ignore (apply to all)',
        value: ChoiceOption.SkipAll,
      },
      {
        name: 'Copy to target location, and replace with a link',
        value: ChoiceOption.Replace,
      },
      {
        name: 'Copy to target location, and replace with a link (apply to all)',
        value: ChoiceOption.ReplaceAll,
      },
    ],
  });

  const foreverAnswers = [ChoiceOption.ReplaceAll, ChoiceOption.SkipAll];
  if (foreverAnswers.includes(answers.linkPresentAction)) {
    inquireExistingSyncEntityAction = async () => answers.linkPresentAction;
  }

  return answers.linkPresentAction;
};

let inquireExistingTargetEntityAction = async function(
  linkGroupName: string,
  targetPath: string,
) {
  let targetType = fs.statSync(targetPath).isDirectory() ? 'directory' : 'file';

  printPreQuestionMessage(oneLine`There is already a
    ${targetType} in your target path: ${tildify(targetPath)}`);

  const answers = await inquirer.prompt({
    name: 'targetPresentAction',
    message: 'What would you like to do?',
    type: 'list',
    choices: [
      {
        name: 'Skip',
        value: ChoiceOption.Skip,
      },
      {
        name: 'Skip (apply to all)',
        value: ChoiceOption.SkipAll,
      },
      {
        name: 'Replace',
        value: ChoiceOption.Replace,
      },
      {
        name: 'Replace (apply to all)',
        value: ChoiceOption.ReplaceAll,
      },
    ],
  });

  const foreverAnswers = [ChoiceOption.ReplaceAll, ChoiceOption.SkipAll];
  if (foreverAnswers.includes(answers.targetPresentAction)) {
    inquireExistingTargetEntityAction = async () => answers.targetPresentAction;
  }

  return answers.targetPresentAction;
};

function printPreQuestionMessage(message: string) {
  logger.print('\n' + chalk.blueBright(`\u2139 ${message}`));
}
