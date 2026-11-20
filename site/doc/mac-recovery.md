# Wake or sign in to a Mac from your phone

Try Remote desktop first if only the display is asleep. For system sleep, a locked account or the startup screen, open **Wake or sign in** in the computer details or offline screen. Save the HTTPS address of your own recovery console. Each browser keeps a separate address for each paired computer. An existing browser-based hardware KVM can also serve as the console.

## Set up an always-on companion

Use a dedicated Linux host with Docker Compose on the Mac's trusted management LAN. Your phone needs a private network route to that host. The companion handles recovery video and account input, so only trusted administrators should control it. Normal Pairfob desktop media and input continue over P2P.

1. Reserve an IPv4 address for the Mac's Ethernet interface. Note its subnet prefix and Ethernet MAC address. Enable Wake for network access. Wake support depends on hardware, power, the network adapter and the lid state.
2. In macOS System Settings → General → Sharing, turn on Screen Sharing for your intended Mac account. Leave the legacy shared VNC password disabled.
3. From the Pairfob checkout on the companion, substitute your addresses below. The output directory must be new. Local ports 18482 and 18483 must be available. Use a dedicated companion, as local users can reach its backend port.

```sh
export PAIRFOB_RECOVERY_DIR="$HOME/pairfob-recovery"
python3 scripts/mac-recovery/configure.py \
  --mac-ip 192.168.1.40/24 --ethernet 02:00:00:00:00:40 \
  --output "$PAIRFOB_RECOVERY_DIR"
docker compose -f scripts/mac-recovery/compose.yaml up -d
```

4. Point your private HTTPS reverse proxy at `http://127.0.0.1:18482`. With Tailscale already set up on both devices and an available HTTPS listener, use `tailscale serve --bg http://127.0.0.1:18482` and restrict access to your devices. Save the resulting HTTPS URL in Pairfob. The console username is `pairfob`. Its generated password is in the private output directory's `console-password` file. Keep it in your password manager. [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)

## Recover the desktop

Open the saved console, sign in and select **Wake and sign in**. The companion sends a wake packet for the configured Ethernet address and requests the credentials required by Mac Screen Sharing. If macOS offers a session selector, choose your existing account and screen. Access to the physical console depends on the Mac's screen sharing behavior. After recovery, return to Pairfob and reconnect to Remote desktop. [Mac Screen Sharing](https://support.apple.com/guide/mac-help/mh11848/mac) · [Guacamole wake and authentication settings](https://guacamole.apache.org/doc/gug/configuring-guacamole.html)

**For FileVault after restart**, Apple silicon Macs with macOS 26 or later can use SSH unlock when Remote Login is enabled and the startup environment has network connectivity. Independently verify the preboot SSH host public key and save one OpenSSH known_hosts line with the Mac's IPv4 address, key type and public key. Add `--known-host /path/to/verified-known-host` during configuration to enable **FileVault SSH**. The companion verifies the host key. Enter your authorized account credentials at the prompt. Unlocking the disk may end the SSH connection. Wait for startup, then use Screen Sharing for the graphical login. Without the verified host key only the Screen Sharing profile is created. Test cold boot, Wi-Fi and third-party adapters on the intended hardware. A hardware KVM is an alternative on Macs that provide boot video and accept its USB keyboard. [Apple FileVault networking requirements](https://support.apple.com/guide/deployment/dep82064ec40/web)

## Disable access

**Remove address** deletes the local shortcut. To shut down the service, run `docker compose -f scripts/mac-recovery/compose.yaml down` on the companion and remove its private HTTPS route. Manage Pairfob pairing, private network access and Mac accounts independently. To rotate the console password, generate a new output directory and recreate the containers with it.
