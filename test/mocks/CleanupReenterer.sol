pragma solidity ^0.8.23;
import {IERC20Router} from "../../src/v1/interfaces/IERC20Router.sol";

interface iM {
    function delegatecallMulticall(
        address[] calldata targets,
        bytes[] calldata datas,
        uint256[] calldata values,
        address refundTo
    ) external payable returns (bytes memory);

    function aggregate(
        address[] calldata targets,
        bytes[] calldata data,
        uint256[] calldata values,
        address refundTo
    ) external payable returns (bytes[] memory);

    function setApprovalForAll(address operator, bool approved) external;
}

contract CleanupReenterer {
    event MsgSender(address sender);

    address public target;
    address public token;
    address public recipient;

    constructor(address _target, address _token, address _recipient) {
        target = _target;
        token = _token;
        recipient = _recipient;
    }

    receive() external payable {
        emit MsgSender(msg.sender);
        IERC20Router(target).cleanupERC20(token, recipient);
    }

    function stealthemoney() external payable {}
}
