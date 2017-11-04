import chalk from 'chalk';
import { oneLine } from 'common-tags';
import * as filenamify from 'filenamify';
import * as fs from 'fs';
import * as inquirer from 'inquirer';
import * as path from 'path';
import * as yaml from 'yamljs';
import expandTilde = require('expand-tilde');
import Logger = require('clix-logger');
import tildify = require('tildify');
import lnk = require('lnk');

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
    await processLinks(linkGroups[i]);
  }

  console.log(linkGroups);
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
  const stat = getStat(linkPath);

  if (stat) {
    // link exists
    console.log('LINK EXISTS');
    const isLinkSymbolic = stat.isSymbolicLink();

    if (isLinkSymbolic) {
      // link is a symbolic link
      console.log('LINK IS SYMBOLIC');
      let currentTarget = fs.readlinkSync(linkPath);

      if (!path.isAbsolute(currentTarget)) {
        // link path is relative, resolve it to the absolute target path
        currentTarget = path.resolve(path.dirname(linkPath), currentTarget);
      }

      if (currentTarget === targetPath) {
        // already links to the desired target
        console.log('LINKED ALREADY, SKIP OVER!');
      } else {
        // links to a different target than desired
        console.log(
          'LINKED TO SOMETHING ELSE:',
          currentTarget,
          ` - Prompt the user about what to do about it. options:
        - point to the new target
        - point to the new target (apply to all)
        - leave the current target intact
        - leave the current target intact (apply to all)`,
        );
      }
    } else {
      console.log('LINK IS PHYSICAL FILE/FOLDER');
      // link is a physical file or folder
      // console.log(
      //   'LINK IS PHYSICAL FILE/FOLDER',
      //   `- Prompt the user about it. Options are:
      // - ignore
      // - ignore (apply to all)
      // - copy to target location, and convert to link
      // - copy to target location, and convert to link (apply to all)

      //   if doing a "copy to target", and there is already a file/dir at the target prompt the user what to do: Options:
      //   - ignore
      //   - ignore (apply to all)
      //   - replace
      //   - replace (apply to all)`,
      // );

      const answers = await inquireExistingSyncEntityAction(
        linkGroupName,
        linkPath,
        targetPath,
      );

      if (
        [ChoiceOption.Replace, ChoiceOption.ReplaceAll].includes(
          answers.linkPresentAction,
        )
      ) {
        console.log('COPY TO TARGET AND CREATE SYMBOLIC LINK');
        // we're copying the entity at link location to the target,
        // then replacing it with a symbolic link to the target
        if (fs.existsSync(targetPath)) {
          console.log('THERE IS A FILE/DIR AT TARGET LOCATION ALREADY');
          // but, there is already an entity at the target path
          if (
            answers.targetPresentAction &&
            [ChoiceOption.Replace, ChoiceOption.ReplaceAll].includes(
              answers.targetPresentAction,
            )
          ) {
            console.log('KEEP A BACKUP AND REPLACE THE TARGET LOCATION ITEM');
          }
        }
      }

      if (fs.existsSync(targetPath)) {
        //
      }

      console.log('OK: ' + JSON.stringify(answers));
    }
  } else {
    // link does not exist
    console.log('LINK DOES NOT EXIST. CREATE IT!');

    await createLink(linkPath, targetPath);
  }
}

async function createLink(linkPath: string, targetPath: string) {
  await lnk([targetPath], path.dirname(linkPath), {
    rename: path.basename(linkPath),
    type: 'symbolic',
  });
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

async function inquireExistingSyncEntityAction(
  linkGroupName: string,
  linkPath: string,
  targetPath: string,
) {
  const type = fs.statSync(linkPath).isDirectory() ? 'directory' : 'file';

  printPreQuestionMessage(oneLine`\u2139 There is already an actual ${type}
  in place of the link for ${linkGroupName} in your sync directory:
  ${tildify(linkPath)}.`);

  const answers = await inquirer.prompt([
    {
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
          name: 'Copy to target location, and convert to link',
          value: ChoiceOption.Replace,
        },
        {
          name: 'Copy to target location, and convert to link (apply to all)',
          value: ChoiceOption.ReplaceAll,
        },
      ],
    },
    {
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
          name: 'Replace target file/directory',
          value: ChoiceOption.Replace,
        },
        {
          name: 'Replace target file/directory (apply to all)',
          value: ChoiceOption.ReplaceAll,
        },
      ],
      when: answers => {
        if (
          [ChoiceOption.Replace, ChoiceOption.ReplaceAll].includes(
            answers.linkPresentAction,
          ) &&
          fs.existsSync(targetPath)
        ) {
          let targetType = fs.statSync(targetPath).isDirectory()
            ? 'directory'
            : 'file';

          printPreQuestionMessage(oneLine`\u2139 There is already a
          ${targetType} in your target path: ${tildify(targetPath)}`);

          return true;
        }

        return false;
      },
    },
  ]);

  return answers as {
    linkPresentAction: ChoiceOption;
    targetPresentAction?: ChoiceOption;
  };
}

function printPreQuestionMessage(message: string) {
  console.log(chalk.blueBright(message));
}

// todo:mm: handle all console.log notes and remove them all!
