import {
  checkXHostAccess,
  detectX11,
  getHostEnvironment,
  isWindowsXServerInstalled,
  isXQuartzInstalled,
  isXQuartzNetworkAccessEnabled,
  isXQuartzRestartNeeded,
} from "#platform/environment/index.js";

export interface X11SetupStatus {
  xServerInstalled: boolean;
  xServerRunning: boolean;
  networkClientsEnabled: boolean;
  xHostConfigured: boolean;
  recommendations: string[];
}

/**
 * Check X11 setup status and provide recommendations
 */
export async function checkX11Setup(): Promise<X11SetupStatus> {
  const environment = getHostEnvironment();
  const currentPlatform = environment.platform;
  const [x11Config, xHostAccess] = await Promise.all([
    detectX11(),
    checkXHostAccess(),
  ]);

  const status: X11SetupStatus = {
    xServerInstalled: false,
    xServerRunning: x11Config.available,
    networkClientsEnabled: false,
    xHostConfigured: xHostAccess.configured,
    recommendations: [],
  };

  switch (currentPlatform) {
    case "darwin":
      return checkX11SetupDarwin(status, x11Config.available);
    case "linux":
      return checkX11SetupLinux(
        status,
        x11Config.available,
        environment.variables.DISPLAY,
      );
    case "win32":
      return checkX11SetupWindows(status, x11Config.available);
    default:
      status.recommendations.push(
        `Platform ${currentPlatform} is not fully supported`,
      );
      return status;
  }
}

/**
 * Check if XQuartz network clients setting is enabled
 * Returns true if enabled, false otherwise
 */
async function checkNetworkClientsSetting(
  status: X11SetupStatus,
): Promise<boolean> {
  if (!status.xServerInstalled) {
    return false;
  }

  const settingEnabled = await isXQuartzNetworkAccessEnabled();
  status.networkClientsEnabled = settingEnabled;

  if (!settingEnabled) {
    status.recommendations.push(
      'Enable "Allow connections from network clients" in XQuartz settings',
    );
    status.recommendations.push("(XQuartz → Settings → Security tab)");
  }

  return settingEnabled;
}

/**
 * Check if XQuartz needs to be restarted for settings to take effect
 */
async function addXQuartzRestartRecommendation(
  status: X11SetupStatus,
): Promise<void> {
  if (!(await isXQuartzRestartNeeded())) return;

  status.recommendations.push(
    "XQuartz is running with old settings. Restart XQuartz:",
  );
  status.recommendations.push("  killall XQuartz");
  status.recommendations.push("  open -a XQuartz");
  status.recommendations.push("");
  status.networkClientsEnabled = false;
}

/**
 * Check X11 setup on macOS
 */
async function checkX11SetupDarwin(
  status: X11SetupStatus,
  x11Available: boolean,
): Promise<X11SetupStatus> {
  status.xServerInstalled = await isXQuartzInstalled();
  if (!status.xServerInstalled) {
    status.recommendations.push("Install XQuartz: brew install --cask xquartz");
  }

  // Check if XQuartz network clients setting is enabled
  const settingEnabled = await checkNetworkClientsSetting(status);

  // Check if XQuartz is running with the correct flags
  if (status.xServerInstalled && x11Available && settingEnabled) {
    await addXQuartzRestartRecommendation(status);
  }

  if (!x11Available) {
    if (status.xServerInstalled) {
      status.recommendations.push("Start XQuartz: open -a XQuartz");
    }
  }

  if (x11Available && !status.xHostConfigured) {
    status.recommendations.push("Configure xhost access in your terminal:");
    status.recommendations.push("  export DISPLAY=:0");
    status.recommendations.push("  xhost +localhost");
    status.recommendations.push("");
    status.recommendations.push(
      "If 'xhost: command not found', add XQuartz to PATH first:",
    );
    status.recommendations.push('  export PATH="/opt/X11/bin:$PATH"');
    status.recommendations.push("");
    status.recommendations.push("To make it permanent, add to ~/.zshrc:");
    status.recommendations.push("  cat >> ~/.zshrc << 'EOF'");
    status.recommendations.push("  export DISPLAY=:0");
    status.recommendations.push("  xhost +localhost 2>/dev/null");
    status.recommendations.push("  EOF");
  }

  return status;
}

/**
 * Check X11 setup on Linux
 */
function checkX11SetupLinux(
  status: X11SetupStatus,
  x11Available: boolean,
  display: string | undefined,
): X11SetupStatus {
  // On Linux, X server is usually installed and running
  if (display) {
    status.xServerInstalled = true;
    status.networkClientsEnabled = true; // Typically doesn't apply
  } else {
    status.recommendations.push(
      "Start X server or set DISPLAY environment variable",
    );
  }

  if (x11Available && !status.xHostConfigured) {
    status.recommendations.push("Configure xhost access in your terminal:");
    status.recommendations.push("  xhost +localhost");
    status.recommendations.push("");
    status.recommendations.push("Or for better security:");
    status.recommendations.push("  xhost +local:docker");
    status.recommendations.push("");
    status.recommendations.push(
      "To make it permanent, add to your shell config:",
    );
    status.recommendations.push("  cat >> ~/.bashrc << 'EOF'  # or ~/.zshrc");
    status.recommendations.push("  xhost +localhost 2>/dev/null");
    status.recommendations.push("  EOF");
  }

  return status;
}

/**
 * Check X11 setup on Windows
 */
async function checkX11SetupWindows(
  status: X11SetupStatus,
  x11Available: boolean,
): Promise<X11SetupStatus> {
  status.xServerInstalled = await isWindowsXServerInstalled();

  if (!status.xServerInstalled) {
    status.recommendations.push("Install VcXsrv or Xming");
    status.recommendations.push(
      "VcXsrv: https://sourceforge.net/projects/vcxsrv/",
    );
  }

  if (!x11Available) {
    if (status.xServerInstalled) {
      status.recommendations.push("Start your X server (VcXsrv or Xming)");
      status.recommendations.push(
        'Use display number 0 and "Multiple windows" mode',
      );
    }
  }

  // Windows X servers typically allow all connections by default
  status.networkClientsEnabled = true;
  status.xHostConfigured = true;

  return status;
}

/**
 * Get platform-specific setup instructions
 */
export function getSetupInstructions(
  targetPlatform: NodeJS.Platform,
): string[] {
  switch (targetPlatform) {
    case "darwin":
      return [
        "1. Install XQuartz:",
        "   brew install --cask xquartz",
        "",
        "2. Configure XQuartz:",
        "   - Open XQuartz → Settings → Security",
        '   - ✓ Enable "Allow connections from network clients"',
        "",
        "3. Restart your Mac (required for XQuartz)",
        "",
        "4. Start XQuartz:",
        "   open -a XQuartz",
        "",
        "5. Configure xhost access:",
        "   xhost +localhost",
        "",
        "6. Run 'sandbox setup-x11' again to validate",
      ];

    case "linux":
      return [
        "1. Ensure X server is running:",
        "   echo $DISPLAY",
        "   (should output something like :0 or :1)",
        "",
        "2. Configure xhost access:",
        "   xhost +localhost",
        "   (or for better security: xhost +local:docker)",
        "",
        "3. Run 'sandbox setup-x11' again to validate",
      ];

    case "win32":
      return [
        "1. Install VcXsrv:",
        "   Download from https://sourceforge.net/projects/vcxsrv/",
        "",
        "2. Start VcXsrv with these settings:",
        "   - Display number: 0",
        '   - "Multiple windows" mode',
        "   - Start no client",
        "   - ✓ Disable access control (or configure firewall)",
        "",
        "3. Run 'sandbox setup-x11' again to validate",
      ];

    default:
      return [`Platform ${targetPlatform} is not fully supported`];
  }
}
