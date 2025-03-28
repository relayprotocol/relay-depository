import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

export type RelayEscrowConfig = {
    owner: Address;
    allocator: Address;
};

export function relayEscrowConfigToCell(config: RelayEscrowConfig): Cell {
    return beginCell().storeAddress(config.owner).storeAddress(config.allocator).endCell();
}

export const Opcodes = {
    setAllocator: 0xebfa1273,

};

export class RelayEscrow implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new RelayEscrow(address);
    }

    static createFromConfig(config: RelayEscrowConfig, code: Cell, workchain = 0) {
        const data = relayEscrowConfigToCell(config);
        const init = { code, data };
        return new RelayEscrow(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async getAllocator(provider: ContractProvider) {
        const result = await provider.get('get_allocator', []);
        return result.stack.readAddress();
    }

    async getOwner(provider: ContractProvider) {
        const result = await provider.get('get_owner', []);
        return result.stack.readAddress();
    }

    async getCurrentBlance(provider: ContractProvider) {
        return (await provider.getState()).balance
    }

    async sendSetAllocator(
        provider: ContractProvider,
        via: Sender,
        opts: {
            allocator: Address;
            value: bigint;
            queryID?: number;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.setAllocator, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.allocator)
                .endCell(),
        });
    }

    async sendDeposit(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint;
            queryID?: number;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }
}
