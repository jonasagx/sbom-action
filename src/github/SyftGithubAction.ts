import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import * as cache from "@actions/tool-cache";
import {
  PullRequestEvent,
  Release,
  ReleaseEvent,
} from "@octokit/webhooks-types";
import * as fs from "fs";
import * as os from "os";
import path from "path";
import stream from "stream";
import { SyftOptions } from "../Syft";
import { dashWrap, debugLog, getClient } from "./GithubClient";

export const SYFT_BINARY_NAME = "syft";
export const SYFT_VERSION = "v0.37.10";

const PRIOR_ARTIFACT_ENV_VAR = "ANCHORE_SBOM_ACTION_PRIOR_ARTIFACT";

/**
 * Tries to get a unique artifact name or otherwise as appropriate as possible
 */
export function getArtifactName(): string {
  const fileName = core.getInput("artifact-name");

  // if there is an explicit filename just return it, this could cause issues
  // where earlier sboms are overwritten by later ones
  if (fileName) {
    return fileName;
  }

  const format = getSbomFormat();
  let extension: string = format;
  switch (format) {
    case "spdx-json":
      extension = "spdx.json";
      break;
    case "json":
      extension = "syft.json";
      break;
  }

  const imageName = core.getInput("image");
  if (imageName) {
    const parts = imageName.split("/");
    // remove the hostname
    if (parts.length > 2) {
      parts.splice(0, 1);
    }
    const prefix = parts.join("-").replace(/[^-a-zA-Z0-9]/, "_");
    return `${prefix}.${extension}`;
  }

  const {
    repo: { repo },
    job,
    action,
  } = github.context;
  // when run without an id, we get various auto-generated names, like:
  // __self __self_2 __anchore_sbom-action  __anchore_sbom-action_2 etc.
  // so just keep the number at the end if there is one, otherwise
  // this will not match an id unless for some reason it starts with __
  let stepName = action.replace(/__[-_a-z]+/, "");
  if (stepName) {
    stepName = `-${stepName}`;
  }
  return `${repo}-${job}${stepName}.${extension}`;
}

/**
 * Maps the given parameter to a Windows Subsystem for Linux style path
 * @param arg
 */
export function mapToWSLPath(arg: string) {
  return arg.replace(
    /^([A-Z]):(.*)$/,
    (v, drive, path) => `/mnt/${drive.toLowerCase()}${path.replace(/\\/g, "/")}`
  );
}

/**
 * Execute directly for linux & macOS and use WSL for Windows
 * @param cmd command to execute
 * @param args command args
 * @param options command options
 */
async function execute(
  cmd: string,
  args: string[],
  options?: exec.ExecOptions
) {
  if (process.platform === "win32") {
    return await exec.exec(
      "wsl",
      [mapToWSLPath(cmd), ...args.map(mapToWSLPath)],
      options
    );
  } else {
    return exec.exec(cmd, args, options);
  }
}

/**
 * Gets a reference to the syft command and executes the syft action
 * @param input syft input parameters
 * @param format syft output format
 */
async function executeSyft({ input, format }: SyftOptions): Promise<string> {
  let stdout = "";

  const cmd = await getSyftCommand();

  const env: { [key: string]: string } = {
    SYFT_CHECK_FOR_APP_UPDATE: "false",
  };

  const registryUser = core.getInput("registry-username");
  const registryPass = core.getInput("registry-password");

  if (registryUser) {
    env.SYFT_REGISTRY_AUTH_USERNAME = registryUser;
    if (registryPass) {
      env.SYFT_REGISTRY_AUTH_PASSWORD = registryPass;
    } else {
      core.warning(
        "WARNING: registry-username specified without registry-password"
      );
    }
  }

  // https://github.com/anchore/syft#configuration
  let args = ["packages", "-vv"];

  if ("image" in input && input.image) {
    if (registryUser) {
      args = [...args, `registry:${input.image}`];
    } else {
      args = [...args, `${input.image}`];
    }
  } else if ("path" in input && input.path) {
    args = [...args, `dir:${input.path}`];
  } else {
    throw new Error("Invalid input, no image or path specified");
  }

  args = [...args, "-o", format];

  // Execute in a group so the syft output is collapsed in the GitHub log
  core.info(`[command]${cmd} ${args.join(" ")}`);

  // This /dev/null writable stream is required so the entire contents
  // of the SBOM is not written to the GitHub action log. the listener below
  // will actually capture the output
  const outStream = new stream.Writable({
    write(buffer, encoding, next) {
      next();
    },
  });

  const exitCode = await core.group("Executing Syft...", async () =>
    execute(cmd, args, {
      env,
      outStream,
      listeners: {
        stdout(buffer) {
          stdout += buffer.toString();
        },
        stderr(buffer) {
          core.info(buffer.toString());
        },
        debug(message) {
          core.debug(message);
        },
      },
    })
  );

  if (exitCode > 0) {
    debugLog("Syft stdout:", stdout);
    throw new Error("An error occurred running Syft");
  } else {
    return stdout;
  }
}

/**
 * Downloads the appropriate Syft binary for the platform
 */
export async function downloadSyft(): Promise<string> {
  const name = SYFT_BINARY_NAME;
  const version = SYFT_VERSION;

  const url = `https://raw.githubusercontent.com/anchore/${name}/main/install.sh`;

  core.debug(`Installing ${name} ${version}`);

  // Download the installer, and run
  const installPath = await cache.downloadTool(url);

  // Make sure the tool's executable bit is set
  const syftBinaryPath = `${installPath}_${name}`;

  await execute("sh", [installPath, "-d", "-b", syftBinaryPath, version]);

  return `${syftBinaryPath}/${name}`;
}

/**
 * Gets the Syft command to run via exec
 */
export async function getSyftCommand(): Promise<string> {
  const name = SYFT_BINARY_NAME;
  const version = SYFT_VERSION;

  let syftPath = cache.find(name, version);
  if (!syftPath) {
    // Not found; download and install it; returns a path to the binary
    syftPath = await downloadSyft();

    // Cache the downloaded file
    syftPath = await cache.cacheFile(syftPath, name, name, version);
  }

  core.debug(`Got Syft path: ${syftPath} binary at: ${syftPath}/${name}`);

  // Add tool to path for this and future actions to use
  core.addPath(syftPath);
  return name;
}

/**
 * Returns the SBOM format as specified by the user, defaults to SPDX
 */
export function getSbomFormat(): SyftOptions["format"] {
  return (core.getInput("format") as SyftOptions["format"]) || "spdx-json";
}

/**
 * Uploads a SBOM as a workflow artifact
 * @param contents SBOM file contents
 */
export async function uploadSbomArtifact(contents: string): Promise<void> {
  const { repo } = github.context;
  const client = getClient(repo, core.getInput("github-token"));

  const fileName = getArtifactName();

  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), "sbom-action-"));
  const filePath = `${tempPath}/${fileName}`;
  fs.writeFileSync(filePath, contents);

  const outputFile = core.getInput("output-file");
  if (outputFile) {
    fs.copyFileSync(filePath, outputFile);
  }

  core.info(dashWrap("Uploading workflow artifacts"));
  core.info(filePath);

  await client.uploadWorkflowArtifact({
    file: filePath,
    name: fileName,
  });
}

/**
 * Gets a boolean input value if supplied, otherwise returns the default
 * @param name name of the input
 * @param defaultValue default value to return if not set
 */
function getBooleanInput(name: string, defaultValue: boolean): boolean {
  const val = core.getInput(name);
  if (val === undefined || val === "") {
    return defaultValue;
  }
  return val.toLowerCase() === "true";
}

/**
 * Optionally fetches the target SBOM in order to provide some information
 * on changes
 */
async function comparePullRequestTargetArtifact(): Promise<void> {
  const doCompare = getBooleanInput("compare-pulls", false);
  const { eventName, payload, repo } = github.context;
  if (doCompare && eventName === "pull_request") {
    const client = getClient(repo, core.getInput("github-token"));

    const pr = (payload as PullRequestEvent).pull_request;
    const branchWorkflow = await client.findLatestWorkflowRunForBranch({
      branch: pr.base.ref,
    });

    debugLog("Got branchWorkflow:", branchWorkflow);

    if (branchWorkflow) {
      const baseBranchArtifacts = await client.listWorkflowRunArtifacts({
        runId: branchWorkflow.id,
      });

      debugLog("Got baseBranchArtifacts:", baseBranchArtifacts);

      for (const artifact of baseBranchArtifacts) {
        if (artifact.name === getArtifactName()) {
          const baseArtifact = await client.downloadWorkflowRunArtifact({
            artifactId: artifact.id,
          });

          core.info(
            `Downloaded SBOM from ref '${pr.base.ref}' to ${baseArtifact}`
          );
        }
      }
    }
  }
}

export async function runSyftAction(): Promise<void> {
  core.info(dashWrap("Running SBOM Action"));

  debugLog(`Got github context:`, github.context);

  const start = Date.now();

  const doUpload = getBooleanInput("upload-artifact", true);

  const output = await executeSyft({
    input: {
      path: core.getInput("path"),
      image: core.getInput("image"),
    },
    format: getSbomFormat(),
  });

  core.info(`SBOM scan completed in: ${(Date.now() - start) / 1000}s`);

  if (output) {
    await comparePullRequestTargetArtifact();

    // We may want to develop a supply chain during the build, this is one
    // potential way to do so:
    const priorArtifact = process.env[PRIOR_ARTIFACT_ENV_VAR];
    if (priorArtifact) {
      core.debug(`Prior artifact: ${priorArtifact}`);
    }

    if (doUpload) {
      await uploadSbomArtifact(output);

      core.exportVariable(PRIOR_ARTIFACT_ENV_VAR, getArtifactName());
    }
  } else {
    throw new Error(`No Syft output: ${JSON.stringify(output)}`);
  }
}

/**
 * Attaches the SBOM assets to a release if run in release mode
 */
export async function attachReleaseAssets(): Promise<void> {
  const doRelease = getBooleanInput("upload-release-assets", true);

  if (!doRelease) {
    return;
  }

  debugLog("Got github context:", github.context);

  const { eventName, ref, payload, repo } = github.context;
  const client = getClient(repo, core.getInput("github-token"));

  let release: Release | undefined = undefined;

  // Try to detect a release
  if (eventName === "release") {
    // Obviously if this is run during a release
    release = (payload as ReleaseEvent).release;
    debugLog("Got releaseEvent:", release);
  } else {
    // We may have a tag-based workflow that creates releases or even drafts
    const releaseRefPrefix =
      core.getInput("release-ref-prefix") || "refs/tags/";
    const isRefPush = eventName === "push" && ref.startsWith(releaseRefPrefix);
    if (isRefPush) {
      const tag = ref.substring(releaseRefPrefix.length);
      release = await client.findRelease({ tag });
      debugLog("Found release for ref push:", release);
    }
  }

  if (release) {
    // ^sbom.*\\.${format}$`;
    const sbomArtifactInput = core.getInput("sbom-artifact-match");
    const sbomArtifactPattern = sbomArtifactInput || `^${getArtifactName()}$`;
    const matcher = new RegExp(sbomArtifactPattern);

    const artifacts = await client.listWorkflowArtifacts();
    let matched = artifacts.filter((a) => {
      const matches = matcher.test(a.name);
      if (matches) {
        core.debug(`Found artifact: ${a.name}`);
      } else {
        core.debug(`Artifact: ${a.name} not matching ${sbomArtifactPattern}`);
      }
      return matches;
    });

    // We may have a release run based on a prior build from another workflow
    if (eventName === "release" && !matched.length) {
      core.info(
        "No artifacts found in this workflow. Searching for release artifacts from prior workflow..."
      );
      const latestRun = await client.findLatestWorkflowRunForBranch({
        branch: release.target_commitish,
      });

      debugLog("Got latest run for prior workflow", latestRun);

      if (latestRun) {
        const runArtifacts = await client.listWorkflowRunArtifacts({
          runId: latestRun.id,
        });

        matched = runArtifacts.filter((a) => {
          const matches = matcher.test(a.name);
          if (matches) {
            core.debug(`Found run artifact: ${a.name}`);
          } else {
            core.debug(
              `Run artifact: ${a.name} not matching ${sbomArtifactPattern}`
            );
          }
          return matches;
        });
      }
    }

    if (!matched.length && sbomArtifactInput) {
      core.warning(`WARNING: no SBOMs found matching ${sbomArtifactInput}`);
      return;
    }

    core.info(dashWrap(`Attaching SBOMs to release: '${release.tag_name}'`));
    for (const artifact of matched) {
      const file = await client.downloadWorkflowArtifact(artifact);

      core.info(file);
      const contents = fs.readFileSync(file);
      const assetName = path.basename(file);

      const assets = await client.listReleaseAssets({
        release,
      });

      const asset = assets.find((a) => a.name === assetName);
      if (asset) {
        await client.deleteReleaseAsset({
          release,
          asset,
        });
      }

      await client.uploadReleaseAsset({
        release,
        assetName,
        contents: contents.toString(),
        contentType: "text/plain",
      });
    }
  }
}

/**
 * Executes the provided callback and wraps any exceptions in a build failure
 */
export async function runAndFailBuildOnException<T>(
  fn: () => Promise<T>
): Promise<T | void> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error) {
      core.setFailed(e.message);
    } else if (e instanceof Object) {
      core.setFailed(JSON.stringify(e));
    } else {
      core.setFailed(`An unknown error occurred: ${e}`);
    }
  }
}
