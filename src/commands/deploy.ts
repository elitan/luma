import { loadConfig } from "../config"; // Assuming loadConfig is exported from src/config/index.ts
import { loadSecrets } from "../config"; // Assuming loadSecrets is exported from src/config/index.ts
import {
  LumaConfig,
  AppEntry,
  ServiceEntry,
  HealthCheckConfig,
  LumaSecrets,
} from "../config/types";
import {
  DockerClient,
  DockerBuildOptions,
  DockerContainerOptions,
} from "../docker"; // Updated path and name
import { SSHClient, SSHClientOptions, getSSHCredentials } from "../ssh"; // Updated to import the utility function
import { generateReleaseId, getProjectNetworkName } from "../utils"; // Changed path and added getProjectNetworkName
import { execSync } from "child_process";
import { LumaProxyClient } from "../proxy";
import { performBlueGreenDeployment } from "./blue-green";
import { Logger } from "../utils/logger";

// Module-level logger that gets configured when deployCommand runs
let logger: Logger;

/**
 * Resolves environment variables for a container from plain and secret sources
 */
function resolveEnvironmentVariables(
  entry: AppEntry | ServiceEntry,
  secrets: LumaSecrets
): Record<string, string> {
  const envVars: Record<string, string> = {};
  if (entry.environment?.plain) {
    for (const [key, value] of Object.entries(entry.environment.plain)) {
      envVars[key] = value;
    }
  }
  if (entry.environment?.secret) {
    for (const secretKey of entry.environment.secret) {
      if (secrets[secretKey] !== undefined) {
        envVars[secretKey] = secrets[secretKey];
      } else {
        logger.warn(
          `Secret key "${secretKey}" for entry "${entry.name}" not found in loaded secrets`
        );
      }
    }
  }
  return envVars;
}

/**
 * Checks if there are uncommitted changes in the working directory
 */
async function hasUncommittedChanges(): Promise<boolean> {
  try {
    const status = execSync("git status --porcelain").toString().trim();
    return status.length > 0;
  } catch (error) {
    logger.verboseLog(
      "Failed to check git status. Assuming no uncommitted changes."
    );
    return false;
  }
}

/**
 * Creates Docker container options for an app entry
 */
function appEntryToContainerOptions(
  appEntry: AppEntry,
  releaseId: string,
  secrets: LumaSecrets,
  projectName: string
): DockerContainerOptions {
  const imageNameWithRelease = `${appEntry.image}:${releaseId}`;
  const containerName = `${appEntry.name}-${releaseId}`;
  const envVars = resolveEnvironmentVariables(appEntry, secrets);
  const networkName = getProjectNetworkName(projectName);

  return {
    name: containerName,
    image: imageNameWithRelease,
    ports: appEntry.ports,
    volumes: appEntry.volumes,
    envVars: envVars,
    network: networkName,
    networkAlias: appEntry.name,
    restart: "unless-stopped",
    // TODO: Add healthcheck options if DockerContainerOptions supports them directly,
    // or handle healthcheck separately after container start.
    // Dockerode, for example, allows specifying Healthcheck in HostConfig
  };
}

/**
 * Creates Docker container options for a service entry
 */
function serviceEntryToContainerOptions(
  serviceEntry: ServiceEntry,
  secrets: LumaSecrets,
  projectName: string
): DockerContainerOptions {
  const containerName = serviceEntry.name; // Services use their simple name
  const envVars = resolveEnvironmentVariables(serviceEntry, secrets);
  const networkName = getProjectNetworkName(projectName);

  return {
    name: containerName,
    image: serviceEntry.image, // Includes tag, e.g., "postgres:15"
    ports: serviceEntry.ports,
    volumes: serviceEntry.volumes,
    envVars: envVars,
    network: networkName, // Assumes network is named project_name-network
    restart: "unless-stopped", // Default restart policy for services
  };
}

/**
 * Converts object or array format configuration entries to a normalized array
 */
function normalizeConfigEntries(
  entries: Record<string, any> | Array<any> | undefined
): Array<any> {
  if (!entries) return [];

  // If it's already an array, return it
  if (Array.isArray(entries)) {
    return entries;
  }

  // If it's an object, convert to array with name property
  return Object.entries(entries).map(([name, entry]) => ({
    ...entry,
    name,
  }));
}

interface DeploymentContext {
  config: LumaConfig;
  secrets: LumaSecrets;
  targetEntries: (AppEntry | ServiceEntry)[];
  releaseId: string;
  projectName: string;
  networkName: string;
  forceFlag: boolean;
  deployServicesFlag: boolean;
  verboseFlag: boolean;
}

interface ParsedArgs {
  entryNames: string[];
  forceFlag: boolean;
  deployServicesFlag: boolean;
  verboseFlag: boolean;
}

/**
 * Parses command line arguments and extracts flags and entry names
 */
function parseDeploymentArgs(rawEntryNamesAndFlags: string[]): ParsedArgs {
  const forceFlag = rawEntryNamesAndFlags.includes("--force");
  const deployServicesFlag = rawEntryNamesAndFlags.includes("--services");
  const verboseFlag = rawEntryNamesAndFlags.includes("--verbose");

  const entryNames = rawEntryNamesAndFlags.filter(
    (name) =>
      name !== "--services" && name !== "--force" && name !== "--verbose"
  );

  return { entryNames, forceFlag, deployServicesFlag, verboseFlag };
}

/**
 * Validates git status and throws error if uncommitted changes exist (unless forced)
 */
async function checkUncommittedChanges(forceFlag: boolean): Promise<void> {
  if (!forceFlag && (await hasUncommittedChanges())) {
    logger.error(
      "Uncommitted changes detected in working directory. Deployment aborted for safety.\n" +
        "Please commit your changes before deploying, or use --force to deploy anyway."
    );
    throw new Error("Uncommitted changes detected");
  }
}

/**
 * Loads and validates Luma configuration and secrets files
 */
async function loadConfigurationAndSecrets(): Promise<{
  config: LumaConfig;
  secrets: LumaSecrets;
}> {
  try {
    const config = await loadConfig();
    const secrets = await loadSecrets();
    return { config, secrets };
  } catch (error) {
    logger.error("Failed to load configuration/secrets", error);
    throw error;
  }
}

/**
 * Determines which apps or services to deploy based on arguments and configuration
 */
function identifyTargetEntries(
  entryNames: string[],
  deployServicesFlag: boolean,
  config: LumaConfig
): (AppEntry | ServiceEntry)[] {
  const configuredApps = normalizeConfigEntries(config.apps);
  const configuredServices = normalizeConfigEntries(config.services);
  let targetEntries: (AppEntry | ServiceEntry)[] = [];

  if (deployServicesFlag) {
    if (entryNames.length === 0) {
      targetEntries = [...configuredServices];
      if (targetEntries.length === 0) {
        logger.warn("No services found in configuration");
        return [];
      }
    } else {
      entryNames.forEach((name) => {
        const service = configuredServices.find((s) => s.name === name);
        if (service) {
          targetEntries.push(service);
        } else {
          logger.warn(`Service "${name}" not found in configuration`);
        }
      });
      if (targetEntries.length === 0) {
        logger.warn("No valid services found for specified names");
        return [];
      }
    }
  } else {
    if (entryNames.length === 0) {
      targetEntries = [...configuredApps];
      if (targetEntries.length === 0) {
        logger.warn("No apps found in configuration");
        return [];
      }
    } else {
      entryNames.forEach((name) => {
        const app = configuredApps.find((a) => a.name === name);
        if (app) {
          targetEntries.push(app);
        } else {
          logger.warn(`App "${name}" not found in configuration`);
        }
      });
      if (targetEntries.length === 0) {
        logger.warn("No valid apps found for specified names");
        return [];
      }
    }
  }

  return targetEntries;
}

/**
 * Verifies that required networks and luma-proxy containers exist on target servers
 */
async function verifyInfrastructure(
  targetEntries: (AppEntry | ServiceEntry)[],
  config: LumaConfig,
  secrets: LumaSecrets,
  networkName: string,
  verbose: boolean = false
): Promise<void> {
  const allTargetServers = new Set<string>();
  targetEntries.forEach((entry) => {
    entry.servers.forEach((server) => allTargetServers.add(server));
  });

  logger.verboseLog(
    `Checking infrastructure on servers: ${Array.from(allTargetServers).join(
      ", "
    )}`
  );

  let missingNetworkServers: string[] = [];
  let missingProxyServers: string[] = [];

  for (const serverHostname of Array.from(allTargetServers)) {
    let sshClientNetwork: SSHClient | undefined;
    try {
      const sshCreds = await getSSHCredentials(
        serverHostname,
        config,
        secrets,
        verbose
      );
      if (!sshCreds.host) sshCreds.host = serverHostname;
      sshClientNetwork = await SSHClient.create(sshCreds as SSHClientOptions);
      await sshClientNetwork.connect();
      const dockerClientRemote = new DockerClient(
        sshClientNetwork,
        serverHostname,
        verbose
      );

      const networkExists = await dockerClientRemote.networkExists(networkName);
      if (!networkExists) {
        missingNetworkServers.push(serverHostname);
      }

      const proxyClient = new LumaProxyClient(
        dockerClientRemote,
        serverHostname
      );
      const proxyRunning = await proxyClient.isProxyRunning();
      if (!proxyRunning) {
        missingProxyServers.push(serverHostname);
      }
    } catch (networkError) {
      logger.verboseLog(`Error verifying ${serverHostname}: ${networkError}`);
      missingNetworkServers.push(serverHostname);
      missingProxyServers.push(serverHostname);
    } finally {
      if (sshClientNetwork) {
        await sshClientNetwork.close();
      }
    }
  }

  if (missingNetworkServers.length > 0 || missingProxyServers.length > 0) {
    if (missingNetworkServers.length > 0) {
      logger.error(
        `Required network "${networkName}" is missing on servers: ${missingNetworkServers.join(
          ", "
        )}`
      );
    }
    if (missingProxyServers.length > 0) {
      logger.error(
        `Required luma-proxy container is not running on servers: ${missingProxyServers.join(
          ", "
        )}`
      );
    }
    logger.error(
      "Please run `luma setup` to create the required infrastructure"
    );
    throw new Error("Infrastructure verification failed");
  }
}

/**
 * Main deployment loop that processes all target entries
 */
async function deployEntries(context: DeploymentContext): Promise<void> {
  const isApp = !context.deployServicesFlag;

  if (isApp) {
    // Build phase for apps
    logger.phase("📦 Building & Pushing Images");
    for (const entry of context.targetEntries) {
      const appEntry = entry as AppEntry;
      await buildAndPushApp(appEntry, context);
    }

    // Deploy phase for apps
    logger.phase("🔄 Deploying to Servers");
    for (const entry of context.targetEntries) {
      const appEntry = entry as AppEntry;
      await deployAppToServers(appEntry, context);
    }
  } else {
    // Deploy phase for services
    logger.phase("🔄 Deploying Services");
    for (const entry of context.targetEntries) {
      await deployService(entry as ServiceEntry, context);
    }
  }
}

/**
 * Builds and pushes an app image (build phase)
 */
async function buildAndPushApp(
  appEntry: AppEntry,
  context: DeploymentContext
): Promise<void> {
  const imageNameWithRelease = `${appEntry.image}:${context.releaseId}`;
  const stepStart = Date.now();

  try {
    const imageReady = await buildOrTagAppImage(
      appEntry,
      imageNameWithRelease,
      context.verboseFlag
    );
    if (!imageReady) throw new Error("Image build failed");

    await pushAppImage(
      appEntry,
      imageNameWithRelease,
      context.config,
      context.verboseFlag
    );

    const duration = Date.now() - stepStart;
    logger.stepComplete(`${appEntry.name} → ${imageNameWithRelease}`, duration);
  } catch (error) {
    logger.stepError(`${appEntry.name} → ${imageNameWithRelease}`, error);
    throw error;
  }
}

/**
 * Deploys an app to all its servers (deployment phase)
 */
async function deployAppToServers(
  appEntry: AppEntry,
  context: DeploymentContext
): Promise<void> {
  logger.server(appEntry.servers.join(", "));

  for (let i = 0; i < appEntry.servers.length; i++) {
    const serverHostname = appEntry.servers[i];
    const isLastServer = i === appEntry.servers.length - 1;

    await deployAppToServer(appEntry, serverHostname, context, isLastServer);
  }
}

/**
 * Builds or tags a Docker image for an app entry
 */
async function buildOrTagAppImage(
  appEntry: AppEntry,
  imageNameWithRelease: string,
  verbose: boolean = false
): Promise<boolean> {
  if (appEntry.build) {
    logger.verboseLog(`Building app ${appEntry.name}...`);
    try {
      const buildPlatform = appEntry.build.platform || "linux/amd64";
      if (!appEntry.build.platform) {
        logger.verboseLog(
          `No platform specified, defaulting to ${buildPlatform}`
        );
      }

      await DockerClient.build({
        context: appEntry.build.context,
        dockerfile: appEntry.build.dockerfile,
        tags: [imageNameWithRelease],
        buildArgs: appEntry.build.args,
        platform: buildPlatform,
        target: appEntry.build.target,
        verbose: verbose,
      });
      logger.verboseLog(
        `Successfully built and tagged ${imageNameWithRelease}`
      );
      return true;
    } catch (error) {
      logger.error(`Failed to build app ${appEntry.name}`, error);
      return false;
    }
  } else {
    logger.verboseLog(
      `Tagging ${appEntry.image} as ${imageNameWithRelease}...`
    );
    try {
      await DockerClient.tag(appEntry.image, imageNameWithRelease, verbose);
      logger.verboseLog(
        `Successfully tagged ${appEntry.image} as ${imageNameWithRelease}`
      );
      return true;
    } catch (error) {
      logger.error(`Failed to tag pre-built image ${appEntry.image}`, error);
      return false;
    }
  }
}

/**
 * Pushes an app image to the configured registry
 */
async function pushAppImage(
  appEntry: AppEntry,
  imageNameWithRelease: string,
  config: LumaConfig,
  verbose: boolean = false
): Promise<void> {
  logger.verboseLog(`Pushing image ${imageNameWithRelease}...`);
  try {
    const registryToPush = appEntry.registry?.url || config.docker?.registry;
    await DockerClient.push(imageNameWithRelease, registryToPush, verbose);
    logger.verboseLog(`Successfully pushed ${imageNameWithRelease}`);
  } catch (error) {
    logger.error(`Failed to push image ${imageNameWithRelease}`, error);
    throw error;
  }
}

/**
 * Builds the full image name with release ID
 */
function buildImageName(appEntry: AppEntry, releaseId: string): string {
  return `${appEntry.image}:${releaseId}`;
}

/**
 * Deploys an app to a specific server using zero-downtime deployment
 */
async function deployAppToServer(
  appEntry: AppEntry,
  serverHostname: string,
  context: DeploymentContext,
  isLastServer: boolean = false
): Promise<void> {
  const stepStart = Date.now();

  try {
    logger.verboseLog(`Deploying ${appEntry.name} to ${serverHostname}`);

    const sshClient = await establishSSHConnection(
      serverHostname,
      context.config,
      context.secrets,
      context.verboseFlag
    );

    const dockerClient = new DockerClient(
      sshClient,
      serverHostname,
      context.verboseFlag
    );

    const imageNameWithRelease = buildImageName(appEntry, context.releaseId);

    // Step 1: Pull image
    const pullStart = Date.now();
    await authenticateAndPullImage(
      appEntry,
      dockerClient,
      context,
      imageNameWithRelease
    );
    const pullDuration = Date.now() - pullStart;
    logger.serverStepComplete(`Pulling image`, pullDuration);

    // Step 2: Zero-downtime deployment
    const deployStart = Date.now();
    const deploymentResult = await performBlueGreenDeployment({
      appEntry,
      releaseId: context.releaseId,
      secrets: context.secrets,
      projectName: context.projectName,
      networkName: context.networkName,
      dockerClient,
      serverHostname,
      verbose: context.verboseFlag,
    });

    if (!deploymentResult.success) {
      await sshClient.close();
      throw new Error(deploymentResult.error || "Deployment failed");
    }
    const deployDuration = Date.now() - deployStart;
    logger.serverStepComplete(`Zero-downtime deployment`, deployDuration);

    // Step 3: Configure proxy
    const proxyStart = Date.now();
    await configureProxyForApp(
      appEntry,
      dockerClient,
      serverHostname,
      context.projectName,
      context.verboseFlag
    );
    const proxyDuration = Date.now() - proxyStart;
    logger.serverStepComplete(`Configuring proxy`, proxyDuration, isLastServer);

    await sshClient.close();
  } catch (error) {
    logger.serverStepError(`${serverHostname}`, error, isLastServer);
    throw error;
  }
}

/**
 * Deploys a single service to all its target servers
 */
async function deployService(
  serviceEntry: ServiceEntry,
  context: DeploymentContext
): Promise<void> {
  logger.verboseLog(
    `Deploying service: ${
      serviceEntry.name
    } to servers: ${serviceEntry.servers.join(", ")}`
  );

  for (const serverHostname of serviceEntry.servers) {
    await deployServiceToServer(serviceEntry, serverHostname, context);
  }
}

/**
 * Deploys a service to a specific server by replacing the existing container
 */
async function deployServiceToServer(
  serviceEntry: ServiceEntry,
  serverHostname: string,
  context: DeploymentContext
): Promise<void> {
  logger.verboseLog(
    `Deploying service ${serviceEntry.name} to server ${serverHostname}`
  );
  let sshClient: SSHClient | undefined;

  try {
    sshClient = await establishSSHConnection(
      serverHostname,
      context.config,
      context.secrets,
      context.verboseFlag
    );
    const dockerClientRemote = new DockerClient(
      sshClient,
      serverHostname,
      context.verboseFlag
    );

    await authenticateAndPullImage(
      serviceEntry,
      dockerClientRemote,
      context,
      serviceEntry.image
    );

    await replaceServiceContainer(
      serviceEntry,
      dockerClientRemote,
      serverHostname,
      context
    );

    logger.verboseLog(`Pruning Docker resources on ${serverHostname}`);
    await dockerClientRemote.prune();

    logger.verboseLog(
      `Service ${serviceEntry.name} deployed successfully to ${serverHostname}`
    );
  } catch (serverError) {
    logger.error(
      `Failed to deploy service ${serviceEntry.name} to ${serverHostname}`,
      serverError
    );
  } finally {
    if (sshClient) {
      await sshClient.close();
    }
  }
}

/**
 * Establishes an SSH connection to a server using configured credentials
 */
async function establishSSHConnection(
  serverHostname: string,
  config: LumaConfig,
  secrets: LumaSecrets,
  verbose: boolean = false
): Promise<SSHClient> {
  const sshCreds = await getSSHCredentials(
    serverHostname,
    config,
    secrets,
    verbose
  );
  if (!sshCreds.host) sshCreds.host = serverHostname;
  const sshClient = await SSHClient.create(sshCreds as SSHClientOptions);
  await sshClient.connect();
  logger.verboseLog(`SSH connection established to ${serverHostname}`);
  return sshClient;
}

/**
 * Handles registry authentication and pulls the specified image
 */
async function authenticateAndPullImage(
  entry: AppEntry | ServiceEntry,
  dockerClientRemote: DockerClient,
  context: DeploymentContext,
  imageToPull: string
): Promise<void> {
  const globalRegistryConfig = context.config.docker;
  const entryRegistry = entry.registry;
  let imageRegistry =
    entryRegistry?.url || globalRegistryConfig?.registry || "docker.io";
  let registryLoginPerformed = false;

  if (entryRegistry?.username && entryRegistry?.password_secret) {
    const password = context.secrets[entryRegistry.password_secret];
    if (password) {
      await performRegistryLogin(
        dockerClientRemote,
        imageRegistry,
        entryRegistry.username,
        password
      );
      registryLoginPerformed = true;
    }
  } else if (
    globalRegistryConfig?.username &&
    context.secrets.DOCKER_REGISTRY_PASSWORD
  ) {
    await performRegistryLogin(
      dockerClientRemote,
      imageRegistry,
      globalRegistryConfig.username,
      context.secrets.DOCKER_REGISTRY_PASSWORD
    );
    registryLoginPerformed = true;
  }

  logger.verboseLog(`Pulling image ${imageToPull}...`);
  const pullSuccess = await dockerClientRemote.pullImage(imageToPull);

  if (registryLoginPerformed) {
    await dockerClientRemote.logout(imageRegistry);
  }

  if (!pullSuccess) {
    throw new Error(`Failed to pull image ${imageToPull}`);
  }
}

/**
 * Performs Docker registry login with error handling for unencrypted warnings
 */
async function performRegistryLogin(
  dockerClient: DockerClient,
  registry: string,
  username: string,
  password: string
): Promise<void> {
  try {
    await dockerClient.login(registry, username, password);
    logger.verboseLog(`Successfully logged into registry`);
  } catch (loginError) {
    const errorMessage = String(loginError);
    if (
      errorMessage.includes("WARNING! Your password will be stored unencrypted")
    ) {
      logger.verboseLog(`Successfully logged into registry`);
    } else {
      logger.error(`Failed to login to registry`, loginError);
    }
  }
}

/**
 * Configures luma-proxy routing for an app's hosts
 */
async function configureProxyForApp(
  appEntry: AppEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  projectName: string,
  verbose: boolean = false
): Promise<void> {
  if (!appEntry.proxy?.hosts?.length) return;

  logger.verboseLog(`Configuring luma-proxy for ${appEntry.name}`);

  const proxyClient = new LumaProxyClient(
    dockerClient,
    serverHostname,
    verbose
  );
  const hosts = appEntry.proxy.hosts;
  const appPort = appEntry.proxy.app_port || 80;

  for (const host of hosts) {
    try {
      const configSuccess = await proxyClient.configureProxy(
        host,
        appEntry.name,
        appPort,
        projectName
      );

      if (!configSuccess) {
        logger.error(`Failed to configure proxy for host ${host}`);
      } else {
        logger.verboseLog(
          `Configured proxy for ${host} → ${appEntry.name}:${appPort}`
        );
      }
    } catch (proxyError) {
      logger.error(`Error configuring proxy for host ${host}`, proxyError);
    }
  }
}

/**
 * Replaces a service container by stopping the old one and creating a new one
 */
async function replaceServiceContainer(
  serviceEntry: ServiceEntry,
  dockerClient: DockerClient,
  serverHostname: string,
  context: DeploymentContext
): Promise<void> {
  const containerName = serviceEntry.name;

  try {
    await dockerClient.stopContainer(containerName);
    await dockerClient.removeContainer(containerName);
  } catch (e) {
    logger.warn(
      `Error stopping/removing old service container on ${serverHostname}: ${e}`
    );
  }

  const serviceContainerOptions = serviceEntryToContainerOptions(
    serviceEntry,
    context.secrets,
    context.projectName
  );

  logger.verboseLog(
    `Starting new service container ${containerName} on ${serverHostname}`
  );
  const createSuccess = await dockerClient.createContainer(
    serviceContainerOptions
  );

  if (!createSuccess) {
    throw new Error(`Failed to create container ${containerName}`);
  }
}

/**
 * Main deployment command that orchestrates the entire deployment process
 */
export async function deployCommand(rawEntryNamesAndFlags: string[]) {
  try {
    const { entryNames, forceFlag, deployServicesFlag, verboseFlag } =
      parseDeploymentArgs(rawEntryNamesAndFlags);

    // Set logger verbose mode
    logger = new Logger({ verbose: verboseFlag });

    // Generate release ID first for the startup message
    const releaseId = await generateReleaseId();
    logger.deploymentStart(releaseId);

    // Check git status
    logger.phase("✅ Configuration loaded");
    await checkUncommittedChanges(forceFlag);

    const { config, secrets } = await loadConfigurationAndSecrets();
    logger.phase("✅ Git status verified");

    const targetEntries = identifyTargetEntries(
      entryNames,
      deployServicesFlag,
      config
    );
    if (targetEntries.length === 0) {
      logger.error("No entries selected for deployment");
      return;
    }

    const projectName = config.name;
    const networkName = getProjectNetworkName(projectName);

    // Verify infrastructure
    logger.phase("✅ Infrastructure ready");
    await verifyInfrastructure(
      targetEntries,
      config,
      secrets,
      networkName,
      verboseFlag
    );

    const context: DeploymentContext = {
      config,
      secrets,
      targetEntries,
      releaseId,
      projectName,
      networkName,
      forceFlag,
      deployServicesFlag,
      verboseFlag,
    };

    await deployEntries(context);

    // Collect URLs for final output
    const urls: string[] = [];
    if (!deployServicesFlag) {
      for (const entry of targetEntries) {
        const appEntry = entry as AppEntry;
        if (appEntry.proxy?.hosts) {
          for (const host of appEntry.proxy.hosts) {
            urls.push(`https://${host}`);
          }
        }
      }
    }

    logger.deploymentComplete(urls);
  } catch (error) {
    logger.deploymentFailed(error);
    process.exit(1);
  }
}
