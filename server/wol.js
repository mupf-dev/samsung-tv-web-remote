// Wake-on-LAN: Magic Packet per UDP; unter WSL2 zusätzlich über Windows, da Broadcasts das NAT nicht verlassen
import dgram from 'node:dgram';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const isWsl = (() => {
  try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
})();

function magicPacket(mac) {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error(`Ungültige MAC-Adresse: ${mac}`);
  const macBuf = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBuf)]);
}

function sendUdp(packet, targets) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => { sock.close(); resolve(); });
    sock.bind(() => {
      sock.setBroadcast(true);
      let left = targets.length * 2;
      for (const host of targets) for (const port of [9, 7]) {
        sock.send(packet, port, host, () => { if (--left === 0) { sock.close(); resolve(); } });
      }
    });
  });
}

function sendViaWindows(mac, broadcast) {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  const script = `$m=[byte[]](('${hex}' -split '(..)' | ? {$_}) | % {[Convert]::ToByte($_,16)});`
    + `$p=[byte[]](,0xFF*6)+($m*16);$u=New-Object Net.Sockets.UdpClient;$u.EnableBroadcast=$true;`
    + `foreach($h in @('255.255.255.255','${broadcast}')){[void]$u.Send($p,$p.Length,$h,9)};$u.Close()`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 8000 }, () => resolve());
  });
}

export async function wake({ mac, host, broadcast = '255.255.255.255' }) {
  const packet = magicPacket(mac);
  await sendUdp(packet, [...new Set(['255.255.255.255', broadcast, host])]);
  if (isWsl) await sendViaWindows(mac, broadcast);
}
