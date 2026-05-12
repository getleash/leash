// SessionKeyValidator — non-root ERC-7579 validator for session keys.
//
// Auto-generated from contracts/out/SessionKeyValidator.sol/SessionKeyValidator.json by
// scripts/sync-abis.ts. Do NOT edit by hand — rerun the script after
// `forge build` instead.

export const sessionKeyValidatorAbi = [
  {
    "type": "function",
    "name": "allowedSelectors",
    "inputs": [
      {
        "name": "kernel",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "selector",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "allowedTargets",
    "inputs": [
      {
        "name": "kernel",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isInitialized",
    "inputs": [
      {
        "name": "kernel",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isModuleType",
    "inputs": [
      {
        "name": "typeId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "isValidSignatureWithSender",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "hash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "sig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxValueByRecipient",
    "inputs": [
      {
        "name": "kernel",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "cap",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "onInstall",
    "inputs": [
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "onUninstall",
    "inputs": [
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "sessions",
    "inputs": [
      {
        "name": "kernel",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "signer",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "validUntil",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "maxValuePerTx",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "validateUserOp",
    "inputs": [
      {
        "name": "userOp",
        "type": "tuple",
        "internalType": "struct PackedUserOperation",
        "components": [
          {
            "name": "sender",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "nonce",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "initCode",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "callData",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "accountGasLimits",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "preVerificationGas",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "gasFees",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "paymasterAndData",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "signature",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      },
      {
        "name": "userOpHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "event",
    "name": "SessionInstalled",
    "inputs": [
      {
        "name": "kernel",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "signer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "validUntil",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      },
      {
        "name": "maxValuePerTx",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "targets",
        "type": "address[]",
        "indexed": false,
        "internalType": "address[]"
      },
      {
        "name": "selectors",
        "type": "bytes4[]",
        "indexed": false,
        "internalType": "bytes4[]"
      },
      {
        "name": "recipients",
        "type": "address[]",
        "indexed": false,
        "internalType": "address[]"
      },
      {
        "name": "recipientCaps",
        "type": "uint256[]",
        "indexed": false,
        "internalType": "uint256[]"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SessionRevoked",
    "inputs": [
      {
        "name": "kernel",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyInitialized",
    "inputs": [
      {
        "name": "smartAccount",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidTargetAddress",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotInitialized",
    "inputs": [
      {
        "name": "smartAccount",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "RecipientCapLengthMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SessionAlreadyInitialized",
    "inputs": [
      {
        "name": "kernel",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SessionNotInitialized",
    "inputs": [
      {
        "name": "kernel",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroRecipientCap",
    "inputs": [
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      }
    ]
  }
] as const;
