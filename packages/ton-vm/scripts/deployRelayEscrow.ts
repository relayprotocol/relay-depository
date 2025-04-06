import { toNano } from '@ton/core';
import { RelayEscrow } from '../wrappers/RelayEscrow';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const relayEscrow = provider.open(
        RelayEscrow.createFromConfig(
            {
                id: Math.floor(Math.random() * 10000),
                counter: 0,
            },
            await compile('RelayEscrow')
        )
    );

    await relayEscrow.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(relayEscrow.address);

    console.log('ID', await relayEscrow.getID());
}
