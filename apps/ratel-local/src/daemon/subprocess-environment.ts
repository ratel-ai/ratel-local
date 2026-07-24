export const DAEMON_INSTALL_PATH_ENV = "RATEL_DAEMON_INSTALL_PATH";

export function daemonSubprocessEnvironment(
  processEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const installPath = processEnv[DAEMON_INSTALL_PATH_ENV];
  if (!installPath) return processEnv;
  return { ...processEnv, PATH: installPath };
}

export function daemonSubprocessPathDescription(processEnv: NodeJS.ProcessEnv): string {
  const installPath = processEnv[DAEMON_INSTALL_PATH_ENV];
  return installPath
    ? `${DAEMON_INSTALL_PATH_ENV}="${installPath}"`
    : `PATH="${processEnv.PATH ?? ""}"`;
}
