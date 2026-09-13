# VM storage budget and upgrade reclamation

The computer settings page persists a finite storage budget in `vm/storage.json` (default 12 GiB; adjustable from 8 to 256 GiB). Existing VMs inherit the default without recreating disks. This budget covers base/system/work images and other files under the VM directory, including its logs.

## Enforcement semantics

This is a monitored storage budget, not an operating-system filesystem quota. File lengths are counted conservatively, so sparse holes are not mistaken for reclaimed physical space. Every 500 ms while the VM runs, the controller checks usage. It verifies the QEMU UUID before pausing at `limit - 1 GiB`; the reserve absorbs in-flight writes, but rapid writes can briefly overshoot. No disk truncation or guest-file deletion is used. Raising the budget resumes only a VM paused by this protection. Lowering it beneath current usage pauses or prevents starting until space is reclaimed or the limit increases.

The setting does not resize guest partitions. The existing virtual capacities remain 16 GiB (system) and 24 GiB (work); increasing the budget alone does not enlarge those capacities. Temporary space required during offline reclamation is outside the running budget and checked separately before conversion.

## Safe reclamation

The manual action first asks the user to save desktop documents. IPC rejects it when tasks, interactions, preview writes or manual desktop control are active. A controller maintenance lock spans cache cleanup, TRIM, graceful shutdown, validation and replacement; new VM commands cannot run inside that interval.

For each disk, the service checks that it is qcow2 and rejects unknown backing files, snapshots, encryption or persistent bitmaps. It creates a sparse candidate while retaining the original, runs `qemu-img check` and a guest-visible `qemu-img compare`, fsyncs the candidate, and records a swap transaction before replacing files. It never uses repair/salvage, force-share, resize or forced VM termination. Candidates that are not smaller are discarded. Insufficient free host space or failed checks preserve the original.

A persistent transaction records conversion/swap intent. Pending swaps restore the original; committed swaps retain the checked replacement and finish deleting only the previous image. Recovery must succeed while offline before the VM can start. User work files, disks from other directories, and unsupported snapshots are not removed.

## Updates and migration

Automatic reclamation is off by default and may be enabled in settings. The updater reclaims at its existing safe shutdown boundary, remembering the target app version after success. The new version's first offline start also checks the version marker, so VMs created before this feature receive a reclamation attempt. Failures leave reclamation pending and visible, preserve the disks, and do not force a shutdown of an already running VM. An old running application receives these changes only after installing a release that includes them.

Daily guest maintenance independently bounds journald and removes regenerable installation caches after successful installation. It does not delete Bot work files or uninstall kernels.

## Validation

`tests/vm-storage.test.ts` covers migration/settings, accounting, reserve thresholds, verified pause/resume, conversion failure, rollback, committed transaction recovery and path rejection. A real QEMU fixture also verifies smaller qcow2 files with identical guest bytes and backing chains. Additional health-channel, shutdown, installer and storage-policy regression tests cover the surrounding lifecycle.