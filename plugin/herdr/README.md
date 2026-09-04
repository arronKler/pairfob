# Pairfob for Herdr

This directory is the thin Herdr adapter for Pairfob. Pairfob remains an
independent daemon and phone PWA; the plugin exposes its existing commands in
Herdr's action menu and interactive panes.

## Install

```sh
herdr plugin install arronKler/pairfob
herdr plugin action invoke pair --plugin pairfob
```

The first **Pairfob: Pair a device** invocation uses the repository's existing
installer when Pairfob is not present. That installer downloads the matching
release from `pairfob.com`, verifies its SHA-256 checksum, enrolls the computer,
and installs the normal launchd or systemd user service. Pairing then continues
in an interactive Herdr overlay.

The plugin does not supervise the daemon. Pairfob continues running when Herdr
detaches or the plugin is removed.

The installed service follows Pairfob's standalone behavior and connects to the
default Herdr server. Invoking an action from a named Herdr session does not
retarget that service.

## Actions

- **Pair a device** opens an interactive QR and approval flow.
- **Check this computer** opens `pairfob doctor` in an overlay.
- **Start**, **Stop**, and **Update** call the installed Pairfob CLI.

**Update** refreshes the standalone Pairfob binary. To refresh this plugin's
manifest and adapter scripts, run `herdr plugin install arronKler/pairfob`
again; Herdr v1 has no separate plugin update command.

Action output for background commands is available through:

```sh
herdr plugin log list --plugin pairfob
```

## Remove

Removing the plugin only removes the Herdr entrypoints. To stop and remove the
background service first:

```sh
pairfob service uninstall
herdr plugin uninstall pairfob
```

Pairfob deliberately keeps paired-device state when its service is uninstalled.
