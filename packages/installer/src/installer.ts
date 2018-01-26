import * as _ from 'lodash';
import * as semver from 'semver';
import { install, idAndTarget } from './yarn';

import { ensureDirSync, existsSync, stat, pathExists, readJson, writeJson } from 'fs-extra';
import { join, resolve } from 'path';

import { buildLogger } from 'log-factory';
import { Reporter } from './reporter';

export enum PackageType {
  FILE = 'file',
  PACKAGE = 'package'
}

export type Input = {
  element: string,
  value: string
};

export type PreInstallRequest = {
  element: string,
  value: string,
  local: boolean,
  type: PackageType,
  hasModel: boolean,
  package?: { name: string }
};

export type PostInstall = {
  moduleId: string,
  version: string,
  resolved: string,
  dependencies: { [key: string]: string }
};

export type PieInfo = {
  hasConfigurePackage: boolean,
  controller?: { dir: string, moduleId: string },
  configure?: { dir: string, moduleId: string }
};

export interface InstalledElement {
  element: string;
  input: Input;
  preInstall: PreInstallRequest;
  postInstall?: PostInstall;
  pie?: PieInfo;
}

const logger = buildLogger();

export type ElementMap = {
  [key: string]: string
}

export type Model = {
  element: string
}

export type Package = {
  name: string,
  version: string
}
export type Models = Model[];

export default class RootInstaller {

  readonly installationDir: string;

  constructor(private cwd: string, private reporter: Reporter) {

    if (!existsSync(cwd)) {
      throw new Error(`cwd does not exist: ${cwd}`);
    }

    this.installationDir = join(cwd, '.pie');
    ensureDirSync(this.installationDir);
  }

  public async install(elements: ElementMap,
    models: Model[]): Promise<{ dir: string, elements: InstalledElement[] }> {

    logger.silly('[install]', elements);

    const inputs: Input[] = _.map(elements, (value, element) => ({ element, value }));
    const requests: PreInstallRequest[] = await createInstallRequests(this.cwd, inputs, models);

    //Note: adjust to the local value to match the installation dir which is 1 level down.
    const mapped = requests.map(r => {
      if (r.local) {
        return { ...r, value: `../${r.value}` };
      } else {
        return r;
      }
    });

    const packages = mapped.filter(r => r.type === 'package');
    logger.debug('writing package.json..')
    await writePackageJson(this.installationDir);
    logger.debug('writing package.json..done');
    const installationResult = await install(this.installationDir, packages.map(r => r.value));

    const out = _.zipWith(inputs, mapped, async (input, preInstall: PreInstallRequest) => {
      const postInstall = findInstallationResult(
        preInstall.local,
        preInstall.value,
        installationResult);

      return {
        element: input.element,
        input,
        postInstall,
        preInstall,
        pie: await addPieInfo(this.installationDir, postInstall)
      }
    });
    logger.silly('out', out);
    return Promise.all(out)
      .then(elements => ({ dir: this.installationDir, elements }));
  }
}

/**
 * Add stub pie information - hasController 
 * @param dir 
 * @param postInstall 
 */
export async function addPieInfo(dir: string, postInstall: PostInstall): Promise<PieInfo | undefined> {

  if (postInstall) {
    const installedPath = join(dir, 'node_modules', postInstall.moduleId);
    const hasController = await pathExists(join(installedPath, 'controller')) &&
      await pathExists(join(installedPath, 'controller', 'package.json'));
    if (hasController) {
      const hasConfigurePackage =
        await pathExists(join(installedPath, 'configure')) &&
        await pathExists(join(installedPath, 'configure', 'package.json'));
      return { hasConfigurePackage };
    } else {
      return undefined;
    }
  } else {
    return undefined;
  }
}

/**
 * TODO: need to check if the yarn key ends with the 
 * install target eg: 
 * name@target // -> ends with @target then use the name.
 * instead of trying to split @ cos there could be multiple in the key. 
 * @param local T
 * @param path 
 * @param installationResult 
 */
export function findInstallationResult(local: boolean, path: string, installationResult: { [key: string]: PostInstall }): PostInstall {

  const findKey = (k: string) => {
    const idt = idAndTarget(k);
    if (local) {
      k.endsWith(path)
      return path === idt.target;
    } else {
      return path === k;
    }
  }

  const k = Object.keys(installationResult).find(findKey);
  const idt = idAndTarget(k);
  return { ...installationResult[k], moduleId: idt.id }
}

export async function writePackageJson(dir: string, data: {} = {}) {
  const info = {
    name: 'x',
    description: 'auto generated package.json',
    private: true,
    version: '0.0.1',
    ...data
  }
  return await writeJson(join(dir, 'package.json'), info);
}

export async function readPackage(dir: string): Promise<Package> {
  const pkgPath = join(dir, 'package.json');
  if (pathExists(pkgPath)) {
    const raw = await readJson(pkgPath);
    return {
      name: raw.name,
      version: raw.version
    }
  }
}

/**
 * add information about the package to install. 
 * @param cwd 
 * @param elements 
 * @param models 
 */
export async function createInstallRequests(
  cwd: string,
  elements: Input[],
  models: Model[]): Promise<PreInstallRequest[]> {
  const mapped = elements.map(async ({ element, value }) => {
    const resolvedPath = resolve(cwd, value);

    logger.silly('resolvedPath: ', resolvedPath);

    const e = await pathExists(resolvedPath);
    logger.silly('path exists: ', e);

    if (e) {
      // const pkg: Package | undefined = await readPackage(resolvedPath);
      const statInfo = await stat(resolvedPath);
      const hasModel = _.some(models, m => m.element === element);
      return {
        element,
        hasModel,
        local: true,
        type: statInfo.isFile() ? PackageType.FILE : PackageType.PACKAGE,
        // package: pkg,
        value
      };
    } else {
      const v = semver.validRange(value) ? `${element}@${value}` : value;
      // const pkg = toPackageInfo(v);
      return {
        element,
        hasModel: _.some(models, m => m.element === element),
        local: false,
        type: PackageType.PACKAGE,
        // package: pkg,
        value: v
      };
    }
  });

  return Promise.all(mapped);
}

