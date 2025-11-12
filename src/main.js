// --- Imports ---
const { WebUSB } = require('usb');
const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

if (require('electron-squirrel-startup')) app.quit();

// --- Globals ---
let tray;
let batteryCheckInterval;
let rootPath;
let cachedDevice = null;
let claimedInterface = null;

// Razer Produkte
const RazerProducts = {
  0x00A4: { name: 'Razer Mouse Dock Pro', transactionId: 0x1f },
  0x00AA: { name: 'Razer Basilisk V3 Pro Wired', transactionId: 0x1f },
  0x00AB: { name: 'Razer Basilisk V3 Pro Wireless', transactionId: 0x1f },
  0x00B9: { name: 'Razer Basilisk V3 X HyperSpeed', transactionId: 0x1f },
  0x007C: { name: 'Razer DeathAdder V2 Pro Wired', transactionId: 0x3f },
  0x007D: { name: 'Razer DeathAdder V2 Pro Wireless', transactionId: 0x3f },
  0x009C: { name: 'Razer DeathAdder V2 X HyperSpeed', transactionId: 0x1f },
  0x00B3: { name: 'Razer Hyperpolling Wireless Dongle', transactionId: 0x1f },
  0x00B6: { name: 'Razer DeathAdder V3 Pro Wired', transactionId: 0x1f },
  0x00B7: { name: 'Razer DeathAdder V3 Pro Wireless', transactionId: 0x1f },
  0x0083: { name: 'Razer Basilisk X HyperSpeed', transactionId: 0x1f },
  0x0086: { name: 'Razer Basilisk Ultimate', transactionId: 0x1f },
  0x0088: { name: 'Razer Basilisk Ultimate Dongle', transactionId: 0x1f },
  0x008F: { name: 'Razer Naga v2 Pro Wired', transactionId: 0x1f },
  0x0090: { name: 'Razer Naga v2 Pro Wireless', transactionId: 0x1f },
  0x00a5: { name: 'Razer Viper V2 Pro Wired', transactionId: 0x1f },
  0x00a6: { name: 'Razer Viper V2 Pro Wireless', transactionId: 0x1f },
  0x007b: { name: 'Razer Viper Ultimate Wired', transactionId: 0x3f },
  0x0078: { name: 'Razer Viper Ultimate Wireless', transactionId: 0x3f },
  0x007a: { name: 'Razer Viper Ultimate Dongle', transactionId: 0x3f },
  0x0555: { name: 'Razer Blackshark V2 Pro RZ04-0453', transactionId: 0x3f },
  0x0528: { name: 'Razer Blackshark V2 Pro RZ04-0322', transactionId: 0x3f },
  0x00af: { name: 'Razer Cobra Pro Wired', transactionId: 0x1f },
  0x00b0: { name: 'Razer Cobra Pro Wireless', transactionId: 0x1f }
};

// --- Helpers ---
function getBatteryIconPath(val) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(val))));
  const iconName = Math.floor(pct / 10) * 10; // 0,10,20,...,100
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

// Gerät einmalig öffnen & claimen (Cache)
async function getOrOpenDevice() {
  if (cachedDevice) return cachedDevice;

  const customWebUSB = new WebUSB({
    devicesFound: devices => devices.find(d => RazerProducts[d.productId])
  });

  const device = await customWebUSB.requestDevice({ filters: [{}] }); // User-Prompt 1x
  if (!device) throw new Error('No Razer device found');

  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);

  const iface = device.configuration.interfaces[0].interfaceNumber;
  await device.claimInterface(iface);

  cachedDevice = device;
  claimedInterface = iface;
  return device;
}

// Akkustand lesen (schnell & robust)
async function readBattery() {
  try {
    const device = await getOrOpenDevice();
    const product = RazerProducts[device.productId];
    const msg = getMessage(product?.transactionId);

    await device.controlTransferOut(
      { requestType: 'class', recipient: 'interface', request: 0x09, value: 0x300, index: claimedInterface },
      msg
    );

    await new Promise(r => setTimeout(r, 150)); // 150ms reicht

    const reply = await device.controlTransferIn(
      { requestType: 'class', recipient: 'interface', request: 0x01, value: 0x300, index: claimedInterface },
      90
    );

    if (!reply?.data || reply.data.byteLength < 10) return undefined;
    const raw = reply.data.getUint8(9);
    return (raw / 255) * 100; // Zahl 0..100
  } catch {
    return undefined;
  }
}

async function setTrayDetails() {
  const batt = await readBattery();

  if (batt === undefined) {
    tray.setImage(nativeImage.createFromPath(path.join(rootPath, 'src/assets/battery_0.png')));
    tray.setToolTip('Device disconnected');
    return;
  }

  const pct = Math.round(batt);
  const iconPath = getBatteryIconPath(pct);

  // Geräte-Name für Tooltip holen
  let modelName = 'Razer Device';
  if (cachedDevice && RazerProducts[cachedDevice.productId]) {
    modelName = RazerProducts[cachedDevice.productId].name.replace(/Wireless|Wired/gi, '').trim();
  }

  tray.setImage(nativeImage.createFromPath(path.join(rootPath, iconPath)));
  tray.setToolTip(`${modelName} – ${pct}%`);
}

// Cleanup
function quitClick() {
  clearInterval(batteryCheckInterval);
  try {
    if (cachedDevice && claimedInterface != null) cachedDevice.releaseInterface(claimedInterface).catch(() => {});
    if (cachedDevice?.opened) cachedDevice.close().catch(() => {});
  } catch {}
  if (process.platform !== 'darwin') app.quit();
}

// --- App lifecycle ---
app.whenReady().then(() => {
  rootPath = app.getAppPath();

  const icon = nativeImage.createFromPath(path.join(rootPath, 'src/assets/battery_0.png'));
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([{ label: 'Quit', type: 'normal', click: quitClick }]);
  tray.setContextMenu(contextMenu);
  tray.setToolTip('Searching for device');

  setTrayDetails();
  batteryCheckInterval = setInterval(setTrayDetails, 30000);
});
