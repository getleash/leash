// LeashFactory — our thin wrapper over KernelFactory; hub+sub registry.
//
// Auto-generated from contracts/out/LeashFactory.sol/LeashFactory.json by
// scripts/sync-abis.ts. Do NOT edit by hand — rerun the script after
// `forge build` instead.

export const leashFactoryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "_kernelFactory",
        "type": "address",
        "internalType": "contract KernelFactory"
      },
      {
        "name": "_ecdsaValidator",
        "type": "address",
        "internalType": "contract ECDSAValidator"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "computeHubAddress",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "computeSubAccountAddress",
    "inputs": [
      {
        "name": "hub",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "agentName",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "deployHub",
    "inputs": [],
    "outputs": [
      {
        "name": "hub",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "deploySubAccount",
    "inputs": [
      {
        "name": "agentName",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [
      {
        "name": "sub",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "ecdsaValidator",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract ECDSAValidator"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hubOf",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "hub",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hubOfSub",
    "inputs": [
      {
        "name": "sub",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "hub",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "kernelFactory",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract KernelFactory"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nameHashOfSub",
    "inputs": [
      {
        "name": "sub",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "agentNameHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ownerOfHub",
    "inputs": [
      {
        "name": "hub",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "subCount",
    "inputs": [
      {
        "name": "hub",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "subOf",
    "inputs": [
      {
        "name": "hub",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "agentNameHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "sub",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "subsOfHub",
    "inputs": [
      {
        "name": "hub",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "HubDeployed",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "hub",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SubAccountDeployed",
    "inputs": [
      {
        "name": "hub",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sub",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "agentNameHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "agentName",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "HubAlreadyDeployed",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "hub",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "HubNotDeployed",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SubAlreadyDeployed",
    "inputs": [
      {
        "name": "hub",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "nameHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "sub",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "UnknownHub",
    "inputs": [
      {
        "name": "hub",
        "type": "address",
        "internalType": "address"
      }
    ]
  }
] as const;
