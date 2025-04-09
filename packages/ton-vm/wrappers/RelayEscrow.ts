import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';
import { sign } from '@ton/crypto';
import { JettonWallet } from "@ton-community/assets-sdk";

export const ADDRESS_NONE = Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c');

export type RelayEscrowConfig = {
    owner: Address;
    allocator: Address;
    nonce: bigint;
};

// Currency types
export enum CurrencyType {
    TON = 0,
    JETTON = 1,
}

// Transfer request without signature
export type TransferRequestData = {
    nonce: bigint;         // 64 bits
    expiry: number;        // 32 bits
    currencyType: CurrencyType;
    to: Address;
    jettonWallet?: Address;  // empty for TON, jetton wallet for Jetton
    currency?: Address;
    amount: bigint;
    gasAmount: bigint;
    forwardAmount: bigint;
};

// Complete transfer request with signature
export type TransferRequest = TransferRequestData & {
    signature: Buffer;      // 512 bits
};

export type DepositEvent = {
    name: 'Deposit',
    data: {
        assetType: number; // 0 for TON, 1 for Jetton
        amount: bigint;
        depositor: string;
        currency: string;
    }
}
  
export type WithdrawEvent = {
    name: 'Withdraw',
    data: {
        currency: string;
        amount: bigint; 
        msgHash: bigint;
    }
}

export function relayEscrowConfigToCell(config: RelayEscrowConfig): Cell {
    return beginCell()
    .storeAddress(config.owner)
    .storeAddress(config.allocator)
    .storeUint(config.nonce, 64)
    .endCell();
}

export const Opcodes = {
    setAllocator: 0xebfa1273,
    transfers: 0xd18ae4c2,
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

    async getNonce(provider: ContractProvider) {
        const result = await provider.get('get_nonce', []);
        return result.stack.readBigNumber();
    }

    async getCurrentBalance(provider: ContractProvider) {
        return (await provider.getState()).balance;
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

    async sendTransfers(
        provider: ContractProvider,
        via: Sender,
        opts: {
            requests: TransferRequest[];
            value: bigint;
            queryID?: number;
        }
    ) {
        // Create transfer data cells
        const transferCells = opts.requests.map(request => this.createTransferDataCell(request));

        // Create actions cell with all transfers
        let actionsBuilder = beginCell().storeUint(transferCells.length, 8);
        for (const cell of transferCells) {
            actionsBuilder.storeRef(cell);
        }

        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.transfers, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeRef(actionsBuilder.endCell())
                .endCell(),
        });
    }

    // Create message cell for signing
    private createSigningMessage(request: TransferRequestData): Cell {
        // Create the same data structure that will be used in the transfer
        return beginCell()
            .storeUint(request.nonce, 64)
            .storeUint(request.expiry, 32)
            .storeUint(request.currencyType, 8)
            .storeAddress(request.to)
            .storeAddress(request.jettonWallet)
            .storeAddress(request.currency)
            .storeCoins(request.amount)
            .storeCoins(request.forwardAmount)
            .storeCoins(request.gasAmount)
            .endCell();
    }

    private createTransferDataCell(request: TransferRequest): Cell {
        const signatureCell = beginCell()
            .storeBuffer(request.signature)
            .endCell();
    
        const mainCell = beginCell()
            .storeUint(request.nonce, 64)
            .storeUint(request.expiry, 32)
            .storeUint(request.currencyType, 8)
            .storeAddress(request.to)
            .storeAddress(request.currencyType === CurrencyType.TON 
                ? ADDRESS_NONE
                : request.jettonWallet)
            .storeAddress(request.currency)
            .storeCoins(request.amount)
            .storeCoins(request.forwardAmount)
            .storeCoins(request.gasAmount);

        return mainCell
            .storeRef(signatureCell)
            .endCell();
    }

   // Generate signature for transfer request
    async signTransfer(request: TransferRequestData, secretKey: Buffer): Promise<Buffer> {
        const message = this.createSigningMessage(request);
        const hash = message.hash();
        return Buffer.from(sign(hash, secretKey));
    }

    // Create new transfer request
    async createTransferRequest(
        provider: ContractProvider,
        secretKey: Buffer,
        opts: {
            currencyType: CurrencyType;
            to: Address;
            jettonWallet?: Address;
            currency?: Address;
            amount: bigint;
            expiryInSeconds?: number;
            nonce?: bigint;
            gasAmount?: bigint;
            forwardAmount?: bigint;
        }
    ): Promise<TransferRequest> {
        // Validate currency address for Jetton transfers
        if (opts.currencyType === CurrencyType.JETTON && !opts.jettonWallet) {
            throw new Error('Currency address is required for Jetton transfers');
        }

        // Get current nonce
        const currentNonce = await this.getNonce(provider);
        const newNonce = opts.nonce ? opts.nonce : BigInt(currentNonce + 1n);

        // Create request data
        const requestData: TransferRequestData = {
            nonce: newNonce,
            expiry: Math.floor(Date.now() / 1000) + (opts.expiryInSeconds || 3600), // Default 1 hour
            currencyType: opts.currencyType,
            to: opts.to,
            jettonWallet: opts.jettonWallet ?? ADDRESS_NONE,
            currency: opts.currency ?? ADDRESS_NONE,
            amount: opts.amount,
            gasAmount: opts.gasAmount ?? 200000000n,
            forwardAmount: opts.forwardAmount ?? 50000000n,
        };

        // Generate signature
        const signature = await this.signTransfer(requestData, secretKey);

        // Return complete transfer request
        return {
            ...requestData,
            signature
        };
    }

    static async parseOutMessage(message: any, provider: ContractProvider): Promise<DepositEvent | WithdrawEvent | null> {
        if (message.info.dest !== null) {
          return null;
        }
        const body = message.body.beginParse();
        body.loadBits(6);
        const eventCode = body.loadUint(32);
        if (eventCode === 989312214) { // Deposit event
            const assetType = body.loadUint(1);
            const jettonWallet = body.loadAddress().toString();
            const amount =  body.loadCoins();
            const depositor = body.loadAddress().toString()

            const eventJettonWallet = provider.open(
                JettonWallet.createFromAddress(
                    Address.parse(jettonWallet)
                )
            );

          return {
            name: "Deposit",
            data: {
                assetType,
                currency: assetType === 0 ? ADDRESS_NONE.toString() : (await eventJettonWallet.getData()).jettonMaster.toString(),
                amount,
                depositor
            }
          };
        } else if (eventCode === 989312215) { // Withdraw event
          return {
            name: "Withdraw",
            data: {
                currency: body.loadAddress().toString(),
                amount: body.loadCoins(),
                msgHash: body.loadUintBig(256)
            }
          };
        }
      
        return null;
    }
}