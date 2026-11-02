// Generated from canonical proposals.py; viewer validation only, never an executor.
export const stewardVocabularySource={"path": "SYSTEMS/echo_node_steward_4b/proposals.py", "sha256": "80b5c5577ac6c6610128d5e4919828d5786fa00a5eab489f0596d7deca861aee", "version": 2} as const;
export const stewardVocabulary:Record<string,Record<string,number>>={
  "svc.control": {
    "status": 0,
    "start": 1,
    "stop": 1,
    "restart": 1,
    "reset_failed": 1,
    "enable": 2,
    "disable": 2,
    "configure": 2
  },
  "task.control": {
    "status": 0,
    "run": 1,
    "enable": 2,
    "disable": 2,
    "create": 2,
    "delete": 3
  },
  "log.tail": {
    "tail": 0
  },
  "fs.op": {
    "stat": 0,
    "list": 0,
    "read": 0,
    "backup": 1,
    "clean": 1,
    "copy": 1,
    "mkdir": 1,
    "restore": 2,
    "move": 2,
    "set_permissions": 2,
    "truncate": 2,
    "delete": 3
  },
  "pkg.op": {
    "list_updates": 0,
    "install": 2,
    "update": 2,
    "rollback": 2,
    "hold": 2,
    "remove": 3
  },
  "proc.op": {
    "list": 0,
    "terminate": 1
  },
  "disk.op": {
    "usage": 0,
    "smart": 0,
    "trim": 1,
    "rotate_logs": 1,
    "mount": 2,
    "remount": 2,
    "unmount": 3
  },
  "gpu.op": {
    "status": 0,
    "set_power_mode": 2,
    "reset": 3
  },
  "net.op": {
    "probe": 0,
    "resolve": 0,
    "flush_dns": 1
  },
  "time.op": {
    "status": 0,
    "sync": 1
  },
  "cert.op": {
    "check": 0,
    "renew": 2
  },
  "config.op": {
    "diff": 0,
    "apply": 2,
    "revert": 2
  },
  "node.power": {
    "wol.send": 1,
    "reboot": 3,
    "shutdown": 3
  }
};
export const stewardIrreversible=new Set(["fs.op/delete", "fs.op/truncate", "pkg.op/remove", "task.control/delete"]);
