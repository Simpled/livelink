import chalk from 'chalk';
import { oneLine } from 'common-tags';
import * as filenamify from 'filenamify';
import * as fs from 'fs-extra';
import * as glob from 'glob';
import * as inquirer from 'inquirer';
import * as path from 'path';
import * as yaml from 'yamljs';
import * as _ from 'lodash';
import Logger = require('clix-logger');
import expandTilde = require('expand-tilde');
import tildify = require('tildify');

const logger = Logger({
  appendTime: false,
  coloredOutput: true,
});

let totalCreated = 0;
let totalSkippedByChoice = 0;
let totalSkippedExisting = 0;

main();

/* ============================================================================
 * Interfaces */

interface LiveLinkConfig {
  [name: string]: string[];
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
  const configPath = await inquireConfigPath(rootDir);

  const config = yaml.load(configPath);
  const linkGroups = generateLinkGroups(rootDir, config);

  for (let i = 0; i < linkGroups.length; i++) {
    console.log();
    await processLinks(linkGroups[i]);
  }

  console.log();
  printFinalTotals();

  console.log();
}

/* ============================================================================
 * Helpers */

function resolveFullPath(somePath: string) {
  return path.resolve(expandTilde(somePath));
}

function getStat(somePath: string) {
  try {
    return fs.lstatSync(somePath);
  } catch (e) {
    return undefined;
  }
}

function generateLinkGroups(rootDir: string, config: LiveLinkConfig) {
  return _(config)
    .keys()
    .sort()
    .map(name => {
      const syncDir = resolveFullPath(path.join(rootDir, name));

      const links = _(config[name])
        .map(targetGlob => resolveFullPath(targetGlob))
        .map(fullTargetGlob => glob.sync(fullTargetGlob))
        .flatten()
        .uniq()
        .filter(targetPath => {
          const isCyclic = isSameOrSubpath(syncDir, targetPath);

          if (isCyclic) {
            logger.warn(
              oneLine`Ignoring cyclic path caused by ${name}: ${targetPath}`,
            );
          }

          return !isCyclic;
        })
        .reduce((acc, targetPath) => {
          const linkFileName = filenamify(targetPath).toLowerCase();

          return {
            ...acc,
            [linkFileName]: targetPath,
          };
        }, {});

      return { name, syncDir, links };
    })
    .value();
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
        totalSkippedExisting++;
      } else {
        // links to a different target than desired
        const action = await inquireExistingLinkToAnotherTargetAction(
          linkGroupName,
          linkPath,
          currentTarget,
        );

        if (
          action === ChoiceOption.Replace ||
          action === ChoiceOption.ReplaceAll
        ) {
          fs.removeSync(linkPath);
        } else {
          skip = true;
          totalSkippedByChoice++;
        }
      }
    } else {
      const action = await inquireExistingSyncEntityAction(
        linkGroupName,
        linkPath,
      );

      if (
        action === ChoiceOption.Replace ||
        action === ChoiceOption.ReplaceAll
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
            fs.renameSync(targetPath, '.livelink-' + targetPath + '-original');
          } else {
            skip = true;
            totalSkippedByChoice++;
          }
        }

        if (!skip) {
          fs.moveSync(linkPath, targetPath);
        }
      } else {
        skip = true;
        totalSkippedByChoice++;
      }
    }
  }

  if (!skip) {
    await fs.ensureSymlink(targetPath, linkPath);
    totalCreated++;
  }
}

async function inquireRootDir() {
  const answers = await inquirer.prompt({
    name: 'rootDir',
    message: 'Enter path to your sync directory:',
    default: tildify(process.cwd()),
    validate: dir => {
      const resolvedRoot = resolveFullPath(dir);
      if (
        !fs.existsSync(resolvedRoot) ||
        !fs.statSync(resolvedRoot).isDirectory()
      ) {
        return `Invalid directory: ${tildify(resolvedRoot)}`;
      }

      return true;
    },
  });

  return answers.rootDir;
}

async function inquireConfigPath(rootDir: string) {
  const answers = await inquirer.prompt({
    name: 'configPath',
    message: 'Enter path to your YAML configuration file:',
    default: tildify(path.join(rootDir, 'livelink.yml')),
    validate: configPath => {
      const resolvedPath = resolveFullPath(configPath);

      if (!fs.existsSync(resolvedPath)) {
        return `No such file found: ${tildify(resolvedPath)}`;
      }

      try {
        yaml.load(resolvedPath);
      } catch {
        return `Not a valid YAML file: ${tildify(resolvedPath)}`;
      }

      return true;
    },
  });

  return resolveFullPath(answers.configPath);
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
    name: 'action',
    type: 'list',
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
  if (foreverAnswers.includes(answers.action)) {
    inquireExistingLinkToAnotherTargetAction = async () => answers.action;
  }

  return answers.action;
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
    name: 'action',
    type: 'list',
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
  if (foreverAnswers.includes(answers.action)) {
    inquireExistingSyncEntityAction = async () => answers.action;
  }

  return answers.action;
};

let inquireExistingTargetEntityAction = async function(
  linkGroupName: string,
  targetPath: string,
) {
  let targetType = fs.statSync(targetPath).isDirectory() ? 'directory' : 'file';

  printPreQuestionMessage(oneLine`There is already a
    ${targetType} in your target path: ${tildify(targetPath)}`);

  const answers = await inquirer.prompt({
    name: 'action',
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
  if (foreverAnswers.includes(answers.action)) {
    inquireExistingTargetEntityAction = async () => answers.action;
  }

  return answers.action;
};

function printPreQuestionMessage(message: string) {
  logger.print('\n' + chalk.blueBright(`\u2139 ${message}`));
}

function printFinalTotals() {
  logger.success('Links unchanged:', totalSkippedExisting);
  logger.success('New links created:', totalCreated);
  logger.success('Skipped by choice:', totalSkippedByChoice);
}

function isSameOrSubpath(subpath: string, parent: string) {
  const noTrailingSep = (p: string) =>
    p[p.length - 1] === path.sep ? p.substr(0, p.length - 1) : p;

  const parentParts = noTrailingSep(parent).split(path.sep);
  const subpathParts = noTrailingSep(subpath).split(path.sep);

  return parentParts.every((part, pos) => subpathParts[pos] === part);
}
