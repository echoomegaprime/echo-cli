// Generated from echo-adk/echo_adk/sdk/{operations,workspace}.py. The owner callback is not an SDK capability.
export const BOT_WORKSPACE_CONTRACT = {
 "continuity.status": {
  "method": "GET",
  "path": "/v2/bots/{bot_id}/continuity",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id"
   ],
   "minProperties": 0
  },
  "readOnly": true,
  "query": []
 },
 "continuity.capture": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/continuity/capture",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "request_ref": {
     "type": "string",
     "pattern": "^[A-Za-z0-9_.:-]{1,100}$"
    },
    "title": {
     "type": "string",
     "minLength": 1,
     "maxLength": 200
    },
    "detail": {
     "type": "string",
     "minLength": 1,
     "maxLength": 4000
    }
   },
   "required": [
    "bot_id",
    "request_ref",
    "title",
    "detail"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "continuity.reconcile": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/continuity/reconcile",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "capture_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id",
    "capture_id"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "marketplace": {
  "method": "GET",
  "path": "/v2/bots/marketplace",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {},
   "required": [],
   "minProperties": 0
  },
  "readOnly": true,
  "query": []
 },
 "connection.list": {
  "method": "GET",
  "path": "/v2/bots/{bot_id}/connections",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id"
   ],
   "minProperties": 0
  },
  "readOnly": true,
  "query": []
 },
 "connection.get": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/connections/get",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "connection_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id",
    "connection_id"
   ],
   "minProperties": 0
  },
  "readOnly": true,
  "query": []
 },
 "connection.refresh": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/connections/refresh",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "connection_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id",
    "connection_id"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "connection.disconnect": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/connections/disconnect",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "connection_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id",
    "connection_id"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "connection.authorize": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/connections/authorize",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "provider_id": {
     "type": "string",
     "pattern": "^[a-z0-9][a-z0-9_.-]{0,79}$"
    },
    "operation_ids": {
     "type": "array",
     "items": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9_.-]{0,79}$"
     },
     "minItems": 1,
     "maxItems": 32,
     "uniqueItems": true
    }
   },
   "required": [
    "bot_id",
    "provider_id",
    "operation_ids"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "connection.invoke": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/connections/invoke",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "connection_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "operation_id": {
     "type": "string",
     "pattern": "^[a-z0-9][a-z0-9_.-]{0,79}$"
    },
    "input_json": {
     "type": "string",
     "minLength": 2,
     "maxLength": 262144
    }
   },
   "required": [
    "bot_id",
    "connection_id",
    "operation_id",
    "input_json"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "subscription.list": {
  "method": "GET",
  "path": "/v2/bots/{bot_id}/subscriptions",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id"
   ],
   "minProperties": 0
  },
  "readOnly": true,
  "query": []
 },
 "subscription.create": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/subscriptions",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "connection_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "operation_id": {
     "type": "string",
     "pattern": "^[a-z0-9][a-z0-9_.-]{0,79}$"
    },
    "params_json": {
     "type": "string",
     "minLength": 2,
     "maxLength": 65536
    },
    "interval_s": {
     "type": "integer",
     "minimum": 60,
     "maximum": 86400
    },
    "predicate_json": {
     "type": "string",
     "minLength": 2,
     "maxLength": 4096
    }
   },
   "required": [
    "bot_id",
    "connection_id",
    "operation_id",
    "params_json",
    "interval_s"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "subscription.enable": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/subscriptions/enable",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "subscription_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id",
    "subscription_id"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "subscription.disable": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/subscriptions/disable",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "subscription_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id",
    "subscription_id"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "subscription.delete": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/subscriptions/delete",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "subscription_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id",
    "subscription_id"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "subscription.poll": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/subscriptions/poll",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "limit": {
     "type": "integer",
     "minimum": 1,
     "maximum": 8
    }
   },
   "required": [
    "bot_id"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "browser.status": {
  "method": "GET",
  "path": "/v2/bots/{bot_id}/browser",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id"
   ],
   "minProperties": 0
  },
  "readOnly": true,
  "query": []
 },
 "browser.act": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/browser/actions",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "action": {
     "type": "string",
     "enum": [
      "navigate",
      "snapshot",
      "screenshot",
      "click",
      "fill"
     ]
    },
    "url": {
     "type": "string",
     "minLength": 1,
     "maxLength": 2048
    },
    "timeout_ms": {
     "type": "integer",
     "minimum": 1,
     "maximum": 30000
    },
    "ref": {
     "type": "string",
     "minLength": 1,
     "maxLength": 100
    },
    "value": {
     "type": "string",
     "maxLength": 4096
    }
   },
   "required": [
    "bot_id",
    "action"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "browser.close": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/browser/close",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "browser.reset": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/browser/reset",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "browser.artifact": {
  "method": "GET",
  "path": "/v2/bots/{bot_id}/browser/artifacts",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "artifact_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id",
    "artifact_id"
   ],
   "minProperties": 0
  },
  "readOnly": true,
  "query": [
   "artifact_id"
  ]
 },
 "memory.read": {
  "method": "GET",
  "path": "/v2/bots/{bot_id}/memory",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "bot_id"
   ],
   "minProperties": 0
  },
  "readOnly": true,
  "query": []
 },
 "memory.edit": {
  "method": "PUT",
  "path": "/v2/bots/{bot_id}/memory",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "text": {
     "type": "string",
     "maxLength": 16000
    },
    "expected_revision": {
     "type": "integer",
     "minimum": 0,
     "maximum": 1000000
    }
   },
   "required": [
    "bot_id",
    "text",
    "expected_revision"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "memory.revisions": {
  "method": "GET",
  "path": "/v2/bots/{bot_id}/memory/revisions",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "limit": {
     "type": "integer",
     "minimum": 1,
     "maximum": 100
    },
    "before": {
     "type": "integer",
     "minimum": 0,
     "maximum": 1000000
    }
   },
   "required": [
    "bot_id"
   ],
   "minProperties": 0
  },
  "readOnly": true,
  "query": [
   "limit",
   "before"
  ]
 },
 "memory.restore": {
  "method": "POST",
  "path": "/v2/bots/{bot_id}/memory/restore",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "revision": {
     "type": "integer",
     "minimum": 0,
     "maximum": 1000000
    },
    "expected_revision": {
     "type": "integer",
     "minimum": 0,
     "maximum": 1000000
    }
   },
   "required": [
    "bot_id",
    "revision",
    "expected_revision"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "team.templates": {
  "method": "GET",
  "path": "/v2/bots/templates",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {},
   "required": [],
   "minProperties": 0
  },
  "readOnly": true,
  "query": []
 },
 "team.template": {
  "method": "GET",
  "path": "/v2/bots/templates/get",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "template_id": {
     "type": "string",
     "pattern": "^[a-z0-9][a-z0-9_.-]{0,79}$"
    }
   },
   "required": [
    "template_id"
   ],
   "minProperties": 0
  },
  "readOnly": true,
  "query": [
   "template_id"
  ]
 },
 "team.export": {
  "method": "POST",
  "path": "/v2/bots/export",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bot_ids": {
     "type": "array",
     "items": {
      "type": "string",
      "pattern": "^[0-9a-f]{32}$"
     },
     "minItems": 1,
     "maxItems": 32,
     "uniqueItems": true
    },
    "name": {
     "type": "string",
     "minLength": 1,
     "maxLength": 80
    },
    "kind": {
     "type": "string",
     "enum": [
      "team",
      "department",
      "template"
     ]
    },
    "include_memory": {
     "type": "boolean"
    }
   },
   "required": [
    "bot_ids",
    "name",
    "kind"
   ],
   "minProperties": 0
  },
  "readOnly": true,
  "query": []
 },
 "team.preview": {
  "method": "POST",
  "path": "/v2/bots/import/preview",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bundle_json": {
     "type": "string",
     "minLength": 2,
     "maxLength": 262144
    },
    "conflict": {
     "type": "string",
     "enum": [
      "reject",
      "reuse_identical"
     ]
    },
    "rename_agents_json": {
     "type": "string",
     "minLength": 2,
     "maxLength": 262144
    },
    "rename_bots_json": {
     "type": "string",
     "minLength": 2,
     "maxLength": 262144
    },
    "include_memory": {
     "type": "boolean"
    }
   },
   "required": [
    "bundle_json"
   ],
   "minProperties": 0
  },
  "readOnly": true,
  "query": []
 },
 "team.import": {
  "method": "POST",
  "path": "/v2/bots/import",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "bundle_json": {
     "type": "string",
     "minLength": 2,
     "maxLength": 262144
    },
    "conflict": {
     "type": "string",
     "enum": [
      "reject",
      "reuse_identical"
     ]
    },
    "rename_agents_json": {
     "type": "string",
     "minLength": 2,
     "maxLength": 262144
    },
    "rename_bots_json": {
     "type": "string",
     "minLength": 2,
     "maxLength": 262144
    },
    "include_memory": {
     "type": "boolean"
    },
    "expected_plan_sha256": {
     "type": "string",
     "pattern": "^[0-9a-f]{64}$"
    }
   },
   "required": [
    "bundle_json",
    "expected_plan_sha256"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "team.imports": {
  "method": "GET",
  "path": "/v2/bots/imports",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {},
   "required": [],
   "minProperties": 0
  },
  "readOnly": true,
  "query": []
 },
 "team.inspect": {
  "method": "POST",
  "path": "/v2/bots/imports/inspect",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "import_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    }
   },
   "required": [
    "import_id"
   ],
   "minProperties": 0
  },
  "readOnly": true,
  "query": []
 },
 "team.recover": {
  "method": "POST",
  "path": "/v2/bots/imports/recover",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "import_id": {
     "type": "string",
     "pattern": "^[0-9a-f]{32}$"
    },
    "expected_recovery_sha256": {
     "type": "string",
     "pattern": "^[0-9a-f]{64}$"
    },
    "action": {
     "type": "string",
     "enum": [
      "rollback",
      "preserve"
     ]
    }
   },
   "required": [
    "import_id",
    "expected_recovery_sha256",
    "action"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 },
 "connection.callback": {
  "method": "POST",
  "path": "/v2/bots/connections/callback",
  "schema": {
   "type": "object",
   "additionalProperties": false,
   "properties": {
    "state": {
     "type": "string",
     "minLength": 16,
     "maxLength": 512
    },
    "code": {
     "type": "string",
     "minLength": 1,
     "maxLength": 4096
    }
   },
   "required": [
    "state",
    "code"
   ],
   "minProperties": 0
  },
  "readOnly": false,
  "query": []
 }
} as const;
export const BOT_SCHEDULE_SCHEMA = {
 "anyOf": [
  {
   "type": "null"
  },
  {
   "anyOf": [
    {
     "type": "object",
     "additionalProperties": false,
     "properties": {
      "every_s": {
       "type": "integer",
       "minimum": 60,
       "maximum": 604800
      },
      "missed": {
       "type": "string",
       "enum": [
        "skip",
        "once"
       ]
      }
     },
     "required": [
      "every_s"
     ],
     "minProperties": 0
    },
    {
     "type": "object",
     "additionalProperties": false,
     "properties": {
      "at": {
       "type": "string",
       "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$"
      },
      "tz": {
       "type": "string",
       "minLength": 1,
       "maxLength": 100
      },
      "weekdays": {
       "type": "array",
       "items": {
        "type": "integer",
        "minimum": 1,
        "maximum": 7
       },
       "minItems": 1,
       "maxItems": 7,
       "uniqueItems": true
      },
      "missed": {
       "type": "string",
       "enum": [
        "skip",
        "once"
       ]
      }
     },
     "required": [
      "at",
      "tz",
      "weekdays"
     ],
     "minProperties": 0
    },
    {
     "type": "object",
     "additionalProperties": false,
     "properties": {
      "once_at": {
       "type": "string",
       "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$"
      },
      "tz": {
       "type": "string",
       "minLength": 1,
       "maxLength": 100
      },
      "missed": {
       "type": "string",
       "enum": [
        "skip",
        "once"
       ]
      }
     },
     "required": [
      "once_at",
      "tz"
     ],
     "minProperties": 0
    },
    {
     "type": "object",
     "additionalProperties": false,
     "properties": {
      "at": {
       "type": "string",
       "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$"
      },
      "tz": {
       "type": "string",
       "minLength": 1,
       "maxLength": 100
      },
      "monthdays": {
       "type": "array",
       "items": {
        "type": "integer",
        "minimum": 1,
        "maximum": 31
       },
       "minItems": 1,
       "maxItems": 31,
       "uniqueItems": true
      },
      "months": {
       "type": "array",
       "items": {
        "type": "integer",
        "minimum": 1,
        "maximum": 12
       },
       "minItems": 1,
       "maxItems": 12,
       "uniqueItems": true
      },
      "missed": {
       "type": "string",
       "enum": [
        "skip",
        "once"
       ]
      }
     },
     "required": [
      "at",
      "tz",
      "monthdays"
     ],
     "minProperties": 0
    },
    {
     "type": "object",
     "additionalProperties": false,
     "properties": {
      "cron": {
       "type": "string",
       "minLength": 9,
       "maxLength": 256
      },
      "tz": {
       "type": "string",
       "minLength": 1,
       "maxLength": 100
      },
      "missed": {
       "type": "string",
       "enum": [
        "skip",
        "once"
       ]
      }
     },
     "required": [
      "cron",
      "tz"
     ],
     "minProperties": 0
    }
   ]
  }
 ]
} as const;
