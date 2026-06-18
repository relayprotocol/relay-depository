module.exports = {
  contracts_directory: "./src",
  compilers: {
    solc: {
      version: "0.8.24",
      settings: {
        optimizer: {
          enabled: true,
        },
        evmVersion: "istanbul",
        viaIR: true,
      },
    },
  },
};
