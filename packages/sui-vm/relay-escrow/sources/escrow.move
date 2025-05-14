module relay_escrow::escrow {
    use sui::coin::{Self, Coin};
    use sui::dynamic_field as df;
    use sui::balance::{Self, Balance};
    use std::type_name::{Self, TypeName};
    use sui::clock::{Self, Clock};
    use std::hash::sha2_256;
    use sui::ed25519;
    use sui::bcs;

    // Error codes
    const ENotAllocator: u64 = 0;
    const EInvalidZeroAddress: u64 = 1;
    const EInvalidSignature: u64 = 2;
    const EExpired: u64 = 3;
    const ERequestExecuted: u64 = 4;
    const EInvalidPublicKey: u64 = 5;

    // Transfer request structure
    public struct TransferRequest has copy, drop {
        recipient: address,    // Destination address
        amount: u64,          // Amount to transfer
        coin_type: TypeName,  // Type of coin to transfer
        nonce: u64,           // Unique nonce
        expiration: u64       // Expiration timestamp
    }

    // Stores executed request hashes
    public struct ExecutedRequests has key {
        id: UID,
        // Map request hash -> bool (using dynamic fields)
    }
    
    // Capability for withdrawing funds
    public struct AllocatorCap has key, store {
        id: UID
    }

    // Main escrow object that holds different types of coins
    public struct Escrow has key {
        id: UID,
        allocator: address,
        allocator_pubkey: vector<u8>,
    }

    public struct AllocatorInfo has copy, drop {
        addr: address,
        pubkey: vector<u8>
    }

    // Events
    public struct DepositEvent has copy, drop {
        coin_type: TypeName,
        amount: u64,
        from: address,
        deposit_id: vector<u8>,
    }

    public struct AllocatorChangedEvent has copy, drop {
        old_allocator: address,
        new_allocator: address
    }

    public struct TransferExecutedEvent has copy, drop {
        request_hash: vector<u8>,
        recipient: address,
        amount: u64,
        coin_type: TypeName,
    }

    // === Public Functions ===

    fun init(ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        
        // Create and share Escrow object
        let escrow = Escrow {
            id: object::new(ctx),
            allocator: sender,
            allocator_pubkey: vector[],
        };
        
        // Create and transfer AllocatorCap to the creator
        let cap = AllocatorCap {
            id: object::new(ctx)
        };

        // Create and share ExecutedRequests storage
        let executed_requests = ExecutedRequests {
            id: object::new(ctx),
        };
        
        transfer::share_object(escrow);
        transfer::share_object(executed_requests);
        transfer::transfer(cap, sender);
    }

    // Deposit any coin type into escrow
    public fun deposit<T>(
        escrow: &mut Escrow,
        coin: Coin<T>,
        id: vector<u8>,
        ctx: &mut TxContext
    ) {
        let coin_type = type_name::get<T>();
        let amount = coin::value(&coin);
        let sender = tx_context::sender(ctx);
        
        // Convert coin to balance and store it
        let balance = coin::into_balance(coin);
        
        if (df::exists_(&escrow.id, coin_type)) {
            let existing_balance = df::borrow_mut<TypeName, Balance<T>>(&mut escrow.id, coin_type);
            balance::join(existing_balance, balance);
        } else {
            df::add(&mut escrow.id, coin_type, balance);
        };

        // Emit deposit event
        sui::event::emit(DepositEvent {
            coin_type,
            amount,
            from: sender,
            deposit_id: id,
        });
    }

    // Check if a request has been executed
    fun is_request_executed(
        executed_requests: &ExecutedRequests, 
        request_hash: vector<u8>
    ): bool {
        df::exists_(&executed_requests.id, request_hash)
    }

    // Mark a request as executed
    fun mark_request_executed(
        executed_requests: &mut ExecutedRequests, 
        request_hash: vector<u8>
    ) {
        df::add(&mut executed_requests.id, request_hash, true);
    }

    // Serialize and hash the request
    fun hash_request(request: &TransferRequest): vector<u8> {
        let serialized = bcs::to_bytes(request);
        sha2_256(serialized)
    }

    // === View Functions ===

    public fun get_allocator(escrow: &Escrow): AllocatorInfo {
        AllocatorInfo {
            addr: escrow.allocator,
            pubkey: escrow.allocator_pubkey
        }
    }

    public fun get_balance<T>(escrow: &Escrow): u64 {
        let coin_type = type_name::get<T>();
        if (!df::exists_(&escrow.id, coin_type)) {
            return 0
        };
        
        let balance = df::borrow<TypeName, Balance<T>>(&escrow.id, coin_type);
        balance::value(balance)
    }

    public fun check_request_executed(
        executed_requests: &mut ExecutedRequests, 
        request_hash: vector<u8>
    ): bool {
        is_request_executed(executed_requests, request_hash)
    }

    // === Entry Functions ===
    // Entry function for depositing any coin type
    public entry fun deposit_coin<T>(
        escrow: &mut Escrow, 
        coin: Coin<T>,
        id: vector<u8>, 
        ctx: &mut TxContext
    ) {
        deposit(escrow, coin, id, ctx)
    }

    // Change allocator - only current allocator can do this
    public entry fun set_allocator(
        escrow: &mut Escrow,
        _cap: &AllocatorCap, 
        new_allocator: address,
        new_pubkey: vector<u8>,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == escrow.allocator, ENotAllocator);
        assert!(new_allocator != @0x0, EInvalidZeroAddress);

        let old_allocator = escrow.allocator;
        escrow.allocator = new_allocator;
        escrow.allocator_pubkey = new_pubkey;

        sui::event::emit(AllocatorChangedEvent {
            old_allocator,
            new_allocator
        });
    }

    // Execute a transfer based on allocator's signature
    public entry fun execute_transfer<T>(
        escrow: &mut Escrow,
        executed_requests: &mut ExecutedRequests,
        recipient: address,
        amount: u64,
        nonce: u64,
        expiration: u64,
        signature: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Construct the transfer request
        let request = TransferRequest {
            recipient,
            amount,
            coin_type: type_name::get<T>(),
            nonce,
            expiration
        };

        // Verify request hasn't expired
        assert!(expiration > clock::timestamp_ms(clock), EExpired);

        // Get request hash
        let request_hash = hash_request(&request);

        // Make sure allocator_pubkey is configured
        assert!(vector::length(&escrow.allocator_pubkey) > 0, EInvalidPublicKey);

        // Verify request hasn't been executed
        assert!(!is_request_executed(executed_requests, request_hash), ERequestExecuted);

        // Verify the signature
        let valid = ed25519::ed25519_verify(&signature, &escrow.allocator_pubkey, &request_hash);
        assert!(valid, EInvalidSignature);

        // Mark request as executed
        mark_request_executed(executed_requests, request_hash);

        // Execute the transfer
        let coin_type = type_name::get<T>();
        let balance = df::borrow_mut<TypeName, Balance<T>>(&mut escrow.id, coin_type);
        let coin = coin::from_balance(balance::split(balance, amount), ctx);
        transfer::public_transfer(coin, recipient);

        // Emit transfer executed event
        sui::event::emit(TransferExecutedEvent {
            request_hash,
            recipient,
            amount,
            coin_type,
        });
    }
}