module relay_escrow::escrow {
    use sui::coin::{Self, Coin};
    use sui::dynamic_field as df;
    use sui::balance::{Self, Balance};
    use std::type_name::{Self, TypeName};
    
    // Error codes
    const ENotAllocator: u64 = 0;
    const EInvalidZeroAddress: u64 = 1;
    
    // Capability for withdrawing funds
    public struct AllocatorCap has key, store {
        id: UID
    }

    // Main escrow object that holds different types of coins
    public struct Escrow has key {
        id: UID,
        allocator: address,
    }

    // Events
    public struct DepositEvent has copy, drop {
        coin_type: TypeName,
        amount: u64,
        from: address,
        deposit_id: ID,
    }

    public struct AllocatorChangedEvent has copy, drop {
        old_allocator: address,
        new_allocator: address
    }

    // === Public Functions ===

    fun init(ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);
        
        // Create and share Escrow object
        let escrow = Escrow {
            id: object::new(ctx),
            allocator: sender,
        };
        
        // Create and transfer AllocatorCap to the creator
        let cap = AllocatorCap {
            id: object::new(ctx)
        };
        
        transfer::share_object(escrow);
        transfer::transfer(cap, sender);
    }

    // Deposit any coin type into escrow
    public fun deposit<T>(
        escrow: &mut Escrow, 
        coin: Coin<T>, 
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
            deposit_id: object::uid_to_inner(&escrow.id),
        });
    }

    // Only allocator can withdraw coins
    public fun withdraw<T>(
        escrow: &mut Escrow,
        _cap: &AllocatorCap,
        amount: u64, 
        recipient: address,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == escrow.allocator, ENotAllocator);
        
        let coin_type = type_name::get<T>();
        let balance = df::borrow_mut<TypeName, Balance<T>>(&mut escrow.id, coin_type);
        
        // Create new coin from balance and transfer
        let coin = coin::from_balance(balance::split(balance, amount), ctx);
        transfer::public_transfer(coin, recipient);
    }

    // === View Functions ===

    public fun get_allocator(escrow: &Escrow): address {
        escrow.allocator  
    }

    public fun get_balance<T>(escrow: &Escrow): u64 {
        let coin_type = type_name::get<T>();
        if (!df::exists_(&escrow.id, coin_type)) {
            return 0
        };
        
        let balance = df::borrow<TypeName, Balance<T>>(&escrow.id, coin_type);
        balance::value(balance)
    }

    // === Entry Functions ===
    // Entry function for depositing any coin type
    public entry fun deposit_coin<T>(
        escrow: &mut Escrow, 
        coin: Coin<T>, 
        ctx: &mut TxContext
    ) {
        deposit(escrow, coin, ctx)
    }

    // Entry function for withdrawing any coin type
    public entry fun withdraw_coin<T>(
        escrow: &mut Escrow,
        cap: &AllocatorCap,
        amount: u64, 
        recipient: address,
        ctx: &mut TxContext
    ) {
        withdraw<T>(escrow, cap, amount, recipient, ctx)
    }

    // Change allocator - only current allocator can do this
    public entry fun set_allocator(
        escrow: &mut Escrow,
        _cap: &AllocatorCap, 
        new_allocator: address,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == escrow.allocator, ENotAllocator);
        assert!(new_allocator != @0x0, EInvalidZeroAddress);

        let old_allocator = escrow.allocator;
        escrow.allocator = new_allocator;

        sui::event::emit(AllocatorChangedEvent {
            old_allocator,
            new_allocator
        });
    }

}