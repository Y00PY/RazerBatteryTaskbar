// --- Imports ---
const { WebUSB } = require("usb");
const { app, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const { exec } = require("child_process");
const { powerMonitor } = require("electron");

// --- Squirrel Setup ---
if (require("electron-squirrel-startup")) app.quit();

// --- Autostart Setup ---
function isInstalledBuild() {
  const lower = process.execPath.toLowerCase();
  return (
    lower.includes("\\appdata\\local\\programs\\") && lower.endsWith(".exe")
  );
}

// Registry-Add
function registerAutoStart() {
  try {
    const isSquirrel = process.execPath.toLowerCase().includes("update.exe");
    let exePath;

    if (isSquirrel) {
      const appFolder = path.dirname(process.execPath);
      exePath = `"${path.join(
        appFolder,
        "..",
        "app-1.0.7",
        "RazerBatteryTaskbar.exe"
      )}"`;
    } else {
      exePath = `"${process.execPath}"`;
    }

    const regPath = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const appName = "RazerBatteryTaskbar";
    const regCmd = `reg add "${regPath}" /v ${appName} /t REG_SZ /d ${exePath} /f`;

    exec(regCmd, (err) => {
      if (err) console.error("❌ Autostart konnte nicht gesetzt werden:", err);
      else
        console.log(
          "✅ RazerBatteryTaskbar im Autostart registriert:",
          exePath
        );
    });
  } catch (e) {
    console.error("Autostart-Fehler:", e);
  }
}

// --- Globals ---
let tray;
let batteryCheckInterval;
let rootPath;
let cachedDevice = null;
let claimedInterface = null;
let consecutiveErrors = 0; // 🔥 NEU: Fehler-Counter

// --- Razer Products ---
const RazerProducts = {
  0x00a4: { name: "Razer Mouse Dock Pro", transactionId: 0x1f },
  0x00aa: { name: "Razer Basilisk V3 Pro Wired", transactionId: 0x1f },
  0x00ab: { name: "Razer Basilisk V3 Pro Wireless", transactionId: 0x1f },
  0x00b9: { name: "Razer Basilisk V3 X HyperSpeed", transactionId: 0x1f },
  0x007c: { name: "Razer DeathAdder V2 Pro Wired", transactionId: 0x3f },
  0x007d: { name: "Razer DeathAdder V2 Pro Wireless", transactionId: 0x3f },
  0x009c: { name: "Razer DeathAdder V2 X HyperSpeed", transactionId: 0x1f },
  0x00b3: { name: "Razer Hyperpolling Wireless Dongle", transactionId: 0x1f },
  0x00b6: { name: "Razer DeathAdder V3 Pro Wired", transactionId: 0x1f },
  0x00b7: { name: "Razer DeathAdder V3 Pro Wireless", transactionId: 0x1f },
  0x0083: { name: "Razer Basilisk X HyperSpeed", transactionId: 0x1f },
  0x0086: { name: "Razer Basilisk Ultimate", transactionId: 0x1f },
  0x0088: { name: "Razer Basilisk Ultimate Dongle", transactionId: 0x1f },
  0x008f: { name: "Razer Naga v2 Pro Wired", transactionId: 0x1f },
  0x0090: { name: "Razer Naga v2 Pro Wireless", transactionId: 0x1f },
  0x00a5: { name: "Razer Viper V2 Pro Wired", transactionId: 0x1f },
  0x00a6: { name: "Razer Viper V2 Pro Wireless", transactionId: 0x1f },
  0x007b: { name: "Razer Viper Ultimate Wired", transactionId: 0x3f },
  0x0078: { name: "Razer Viper Ultimate Wireless", transactionId: 0x3f },
  0x007a: { name: "Razer Viper Ultimate Dongle", transactionId: 0x3f },
  0x0555: { name: "Razer Blackshark V2 Pro RZ04-0453", transactionId: 0x3f },
  0x0528: { name: "Razer Blackshark V2 Pro RZ04-0322", transactionId: 0x3f },
  0x00af: { name: "Razer Cobra Pro Wired", transactionId: 0x1f },
  0x00b0: { name: "Razer Cobra Pro Wireless", transactionId: 0x1f },
};

// --- Helpers ---
function getBatteryIconPath(val) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(val))));
  const iconName = Math.floor(pct / 10) * 10;
  return `src/assets/battery_${iconName}.png`;
}

function getMessage(transactionId) {
  const tid = transactionId ?? 0x1f;
  let msg = Buffer.from([0x00, tid, 0x00, 0x00, 0x00, 0x02, 0x07, 0x80]);
  let crc = 0;
  for (let i = 2; i < msg.length; i++) crc ^= msg[i];
  msg = Buffer.concat([msg, Buffer.alloc(80)]);
  msg = Buffer.concat([msg, Buffer.from([crc, 0])]);
  return msg;
}

// 🔥 NEU: Device Cleanup
async function cleanupDevice() {
  try {
    if (cachedDevice && claimedInterface != null) {
      await cachedDevice.releaseInterface(claimedInterface).catch(() => {});
    }
    if (cachedDevice?.opened) {
      await cachedDevice.close().catch(() => {});
    }
  } catch (err) {
    console.error("⚠️ Error during device cleanup:", err);
  } finally {
    cachedDevice = null;
    claimedInterface = null;
  }
}

// 🔥 GEÄNDERT: Mit vollständigem Error Handling
async function getOrOpenDevice() {
  try {
    if (cachedDevice) return cachedDevice;

    const customWebUSB = new WebUSB({
      devicesFound: (devices) =>
        devices.find((d) => RazerProducts[d.productId]),
    });

    const device = await customWebUSB.requestDevice({ filters: [{}] });
    if (!device) throw new Error("No Razer device found");

    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);

    const iface = device.configuration.interfaces[0].interfaceNumber;
    await device.claimInterface(iface);

    cachedDevice = device;
    claimedInterface = iface;

    consecutiveErrors = 0; // 🔥 Reset error counter bei Erfolg
    console.log(
      "✅ Device successfully opened:",
      RazerProducts[device.productId]?.name
    );

    return device;
  } catch (err) {
    console.error("❌ Error opening device:", err.message);
    await cleanupDevice(); // 🔥 Cleanup bei Fehler
    throw err;
  }
}

// 🔥 GEÄNDERT: Mit robustem Error Handling
async function readBattery() {
  try {
    const device = await getOrOpenDevice();
    const product = RazerProducts[device.productId];
    const msg = getMessage(product?.transactionId);

    await device.controlTransferOut(
      {
        requestType: "class",
        recipient: "interface",
        request: 0x09,
        value: 0x300,
        index: claimedInterface,
      },
      msg
    );

    await new Promise((r) => setTimeout(r, 150));

    const reply = await device.controlTransferIn(
      {
        requestType: "class",
        recipient: "interface",
        request: 0x01,
        value: 0x300,
        index: claimedInterface,
      },
      90
    );

    if (!reply?.data || reply.data.byteLength < 10) {
      console.warn("⚠️ Invalid battery response received");
      return undefined;
    }

    const raw = reply.data.getUint8(9);
    const batteryPct = (raw / 255) * 100;

    consecutiveErrors = 0; // 🔥 Reset bei erfolgreichem Read
    return batteryPct;
  } catch (err) {
    consecutiveErrors++; // 🔥 Increment error counter
    console.error(
      `❌ Error reading battery (error #${consecutiveErrors}):`,
      err.message
    );

    // 🔥 Bei mehreren Fehlern: Device-Cache invalidieren
    if (consecutiveErrors >= 3) {
      console.log("🔄 Too many errors, resetting device connection...");
      await cleanupDevice();
    }

    return undefined;
  }
}

// 🔥 GEÄNDERT: Mit Try-Catch um gesamte Funktion
async function setTrayDetails() {
  try {
    const batt = await readBattery();

    if (batt === undefined) {
      tray.setImage(
        nativeImage.createFromPath(
          path.join(rootPath, "src/assets/battery_0.png")
        )
      );
      tray.setToolTip("Device disconnected");
      return;
    }

    const pct = Math.round(batt);
    const iconPath = getBatteryIconPath(pct);

    let modelName = "Razer Device";
    if (cachedDevice && RazerProducts[cachedDevice.productId]) {
      modelName = RazerProducts[cachedDevice.productId].name
        .replace(/Wireless|Wired/gi, "")
        .trim();
    }

    tray.setImage(nativeImage.createFromPath(path.join(rootPath, iconPath)));
    tray.setToolTip(`${modelName} – ${pct}%`);

    console.log(`🔋 Battery updated: ${pct}%`);
  } catch (err) {
    // 🔥 NEU: Catch für gesamte Tray-Update-Funktion
    console.error("❌ Critical error in setTrayDetails:", err);

    try {
      tray.setImage(
        nativeImage.createFromPath(
          path.join(rootPath, "src/assets/battery_0.png")
        )
      );
      tray.setToolTip("Error - retrying...");
    } catch (trayErr) {
      console.error("❌ Failed to update tray icon:", trayErr);
    }

    // 🔥 Bei kritischem Fehler: Device neu initialisieren
    await cleanupDevice();
  }
}

// --- Quit Handler ---
function quitClick() {
  clearInterval(batteryCheckInterval);
  cleanupDevice().then(() => {
    if (process.platform !== "darwin") app.quit();
  });
}

// 🔥 GEÄNDERT: Robuster Resume Handler
powerMonitor.on("resume", async () => {
  console.log("💡 System resumed from sleep – refreshing battery status");

  try {
    // 🔥 Immer Device-Cache invalidieren nach Resume
    await cleanupDevice();
    consecutiveErrors = 0;

    // 🔥 Erst 3 Sekunden warten, bis USB enumeriert ist
    setTimeout(() => {
      let retries = 0;
      const tryRefresh = setInterval(async () => {
        try {
          retries++;
          console.log(`🔄 Resume retry attempt ${retries}/10...`);

          const batt = await readBattery();

          if (batt !== undefined && batt > 0) {
            console.log(
              `✅ Battery detected after resume: ${Math.round(batt)}%`
            );
            await setTrayDetails();
            clearInterval(tryRefresh);
          } else if (retries >= 10) {
            console.log("❌ No device detected after resume (timeout)");
            clearInterval(tryRefresh);
            // 🔥 Auch bei Timeout: Clean state
            await cleanupDevice();
          }
        } catch (err) {
          console.error(
            `❌ Error during resume retry ${retries}:`,
            err.message
          );

          if (retries >= 10) {
            console.log("❌ Max retries reached, stopping...");
            clearInterval(tryRefresh);
            await cleanupDevice();
          }
        }
      }, 3000);
    }, 3000);
  } catch (err) {
    console.error("❌ Critical error in resume handler:", err);
  }
});

// --- App Lifecycle ---
app.whenReady().then(() => {
  try {
    rootPath = app.getAppPath();

    const icon = nativeImage.createFromPath(
      path.join(rootPath, "src/assets/battery_0.png")
    );
    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
      { label: "Quit", type: "normal", click: quitClick },
    ]);
    tray.setContextMenu(contextMenu);
    tray.setToolTip("Checking battery... (10s)");

    // 🔥 10 Sekunden Delay mit Error Handling
    setTimeout(async () => {
      try {
        await setTrayDetails();

        // 🔥 GEÄNDERT: Interval mit Error Handling
        batteryCheckInterval = setInterval(async () => {
          try {
            await setTrayDetails();
          } catch (err) {
            console.error("❌ Error in battery check interval:", err);
          }
        }, 10000);
      } catch (err) {
        console.error("❌ Error during initial battery check:", err);
      }
    }, 10000);

    registerAutoStart();
  } catch (err) {
    console.error("❌ Critical error during app initialization:", err);
    app.quit();
  }
});

// 🔥 NEU: Unhandled rejection handler
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Promise Rejection:", reason);
  cleanupDevice();
});

// 🔥 NEU: Uncaught exception handler
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
  cleanupDevice();
});
