-- The lazy expiry sweep must survive an INSUFFICIENT_CREDITS failure.
--
-- 0071's spend_credits() ran the lazy expiry sweep (invariant 3) and the debit
-- attempt as one flat sequence of statements inside a single implicit
-- transaction (the whole function call is one statement, per invariant 4 -
-- required so nothing spans two backends over the Supabase transaction
-- pooler). `raise exception 'INSUFFICIENT_CREDITS'` when the debit can't be
-- covered rolled back EVERYTHING done earlier in that same statement,
-- including the sweep that had already run moments before under the same
-- lock. Reproduced against credit_system_test: a tenant with a single
-- 1,000,000-micro grant expired a day ago, balance_micro = 1,000,000; a call
-- spending -50,000 raises INSUFFICIENT_CREDITS and leaves balance_micro at
-- 1,000,000, zero `expiry` ledger rows, and the grant's spent_micro at 0 -
-- the sweep it had just performed vanished with the failed debit.
--
-- Consequence at the seam: apps/agent-orchestrator/src/credits.ts's chat
-- pre-check reads the stale (overstated) balance and passes, debitChatTurn
-- swallows the resulting spend_credits() error, and the tenant chats free
-- until the nightly credits.expire worker job catches up - up to 24 hours,
-- unbounded in volume.
--
-- Fix, staying inside ONE statement (hard constraint: no client-side
-- BEGIN/COMMIT, no follow-up call):
--
--   1. The sweep now commits its own `credit_accounts.balance_micro` update
--      immediately after the sweep loop, before the debit is even attempted.
--   2. The debit attempt (grant updates + ledger inserts + the
--      INSUFFICIENT_CREDITS raise) is wrapped in a nested `begin ... exception
--      ... end` block. PL/pgSQL takes an implicit savepoint at the start of
--      that block; catching the raised exception there rolls back only the
--      writes made inside the block (the partial debit rows - the same "no
--      partial debit rows survive" guarantee as before), leaving the sweep's
--      already-committed update untouched.
--   3. The function no longer raises SQLSTATE P0001 out to the caller for a
--      plain shortfall (it still can for a genuine unexpected error - that
--      case is not caught here and propagates as before, correctly rolling
--      back the whole call). Instead its signature grows two OUT parameters,
--      `insufficient` and `short_by`, so the shortfall is reported through the
--      function's normal return path - which is what lets the transaction
--      commit (with the sweep intact) instead of aborting.
--   4. packages/foundation/credits/src/spend.ts (the sole caller) is updated
--      in the same change to read `insufficient` and throw
--      InsufficientCreditsError in TypeScript, preserving the exact external
--      contract every existing call site already relies on.
--
-- Return type changes from `bigint` to a row of three columns, which
-- `create or replace function` cannot do in place - drop first.

DROP FUNCTION IF EXISTS spend_credits(
  uuid, bigint, text, text, uuid, actor_type, uuid, integer, uuid, text, text, timestamptz, text
);--> statement-breakpoint

CREATE FUNCTION spend_credits(
  p_tenant       uuid,
  p_amount_micro bigint,     -- negative = debit, positive = credit
  p_key          text,
  p_kind         text,       -- 'debit' | 'refund' | 'settle' | 'grant' | 'adjust'
  p_actor        uuid,
  p_actor_type   actor_type,
  p_rate_id      uuid    default null,
  p_rate_version integer default null,
  p_job_id       uuid    default null,
  p_job_type     text    default null,
  p_grant_type   text    default null,        -- positive amounts only
  p_expires_at   timestamptz default null,    -- positive amounts only
  p_reason       text    default null,
  out new_balance  bigint,    -- balance after this call (post-sweep, and post-debit if it succeeded)
  out insufficient boolean,   -- true when a requested debit could not be fully covered; new_balance is still the swept balance
  out short_by     bigint     -- amount still short when insufficient; 0 otherwise
)
language plpgsql
as $$
declare
  v_balance       bigint;
  v_remaining     bigint;
  v_take          bigint;
  v_seq           integer := 0;
  v_grant         record;
  v_grant_id      uuid;
  v_dummy         bigint;
  v_debit_balance bigint;
begin
  insufficient := false;
  short_by := 0;

  insert into credit_accounts (tenant_id) values (p_tenant) on conflict do nothing;

  select balance_micro into v_balance
    from credit_accounts
   where tenant_id = p_tenant
     for update;

  -- Replay check AFTER the lock: concurrent duplicates serialize into a clean
  -- replay instead of one of them dying on the unique index. Matches 0071:
  -- a replay returns before the sweep ever runs.
  select balance_after_micro into v_dummy
    from credit_ledger
   where tenant_id = p_tenant
     and idempotency_key = p_key
   order by seq desc
   limit 1;
  if found then
    new_balance := v_balance;
    return;
  end if;

  -- Lazy expiry under the same lock (invariant 3). Keeps balance_micro equal
  -- to the sum of live grant remainders at all times, not just after the
  -- cron. Unconditional: this must survive even when the debit below is
  -- short, or a spend that fails discards the very expiry it just found.
  for v_grant in
    select * from credit_grants
     where tenant_id = p_tenant
       and expires_at is not null
       and expires_at <= now()
       and spent_micro < amount_micro
     order by created_at
     for update
  loop
    v_take := v_grant.amount_micro - v_grant.spent_micro;
    update credit_grants set spent_micro = amount_micro where id = v_grant.id;
    v_balance := v_balance - v_take;
    insert into credit_ledger (tenant_id, grant_id, kind, amount_micro,
                               balance_after_micro, idempotency_key, seq, reason)
      values (p_tenant, v_grant.id, 'expiry', -v_take, v_balance,
              'expiry:' || v_grant.id::text, 0, 'grant expired');
  end loop;

  -- Persist the sweep now, independent of the debit attempt below. The nested
  -- block below takes its own savepoint AFTER this write, so a rollback
  -- inside that block (on INSUFFICIENT_CREDITS) can never touch it.
  update credit_accounts
     set balance_micro = v_balance, updated_at = now()
   where tenant_id = p_tenant;
  new_balance := v_balance;

  if p_amount_micro < 0 then
    v_remaining := -p_amount_micro;
    v_debit_balance := v_balance;

    begin
      for v_grant in
        select * from credit_grants
         where tenant_id = p_tenant
           and spent_micro < amount_micro
           and (expires_at is null or expires_at > now())
         order by expires_at nulls last, created_at
         for update
      loop
        exit when v_remaining <= 0;
        v_take := least(v_grant.amount_micro - v_grant.spent_micro, v_remaining);
        update credit_grants set spent_micro = spent_micro + v_take where id = v_grant.id;
        v_debit_balance := v_debit_balance - v_take;
        v_remaining := v_remaining - v_take;
        insert into credit_ledger (tenant_id, actor_id, actor_type, grant_id, kind,
                                   amount_micro, balance_after_micro, job_id, job_type,
                                   rate_id, rate_version, idempotency_key, seq, reason)
          values (p_tenant, p_actor, p_actor_type, v_grant.id, p_kind,
                  -v_take, v_debit_balance, p_job_id, p_job_type,
                  p_rate_id, p_rate_version, p_key, v_seq, p_reason);
        v_seq := v_seq + 1;
      end loop;

      if v_remaining > 0 then
        raise exception 'INSUFFICIENT_CREDITS'
          using errcode = 'P0001',
                detail  = format('short by %s micro', v_remaining);
      end if;

      -- Success: commit the debit's balance on top of the already-swept one.
      update credit_accounts
         set balance_micro = v_debit_balance, updated_at = now()
       where tenant_id = p_tenant;
      new_balance := v_debit_balance;

    exception when sqlstate 'P0001' then
      -- `sqlstate 'P0001'` is the default code for ANY bare `raise
      -- exception` in Postgres, not one private to the shortfall raise
      -- above - a future raise added to this block, or a trigger firing on
      -- credit_grants/credit_ledger during one of the inserts/updates in the
      -- loop, would land here too. Without this guard that would be
      -- silently reported as insufficient = true and surface as a 402,
      -- masking a real bug as a billing message. v_remaining > 0 is exactly
      -- the condition the shortfall raise itself checked immediately before
      -- raising, and nothing between that check and here can change it, so
      -- it reliably distinguishes "this is our own shortfall" from
      -- "something else raised P0001".
      if v_remaining > 0 then
        -- Rolls back to the implicit savepoint at this block's `begin`:
        -- every credit_grants update and credit_ledger debit row inserted
        -- in this loop is undone - the same "no partial debit rows
        -- survive" guarantee 0071 had - but the sweep's update above, made
        -- before this savepoint, is untouched. Report the shortfall
        -- through the OUT params rather than re-raising: re-raising here
        -- would abort the whole statement and take the sweep down with
        -- it, which is the exact bug this migration fixes. v_remaining
        -- still holds the shortfall - local variable assignments are not
        -- part of what a savepoint rollback undoes.
        insufficient := true;
        short_by := v_remaining;
        new_balance := v_balance; -- swept balance; no debit applied
      else
        raise;
      end if;
    end;

  elsif p_amount_micro > 0 then
    -- A credit ALWAYS creates a new grant. Never un-spend an old one: it may
    -- have expired, and the credits would then sit in the balance where FIFO
    -- cannot reach them (invariant 3).
    --
    -- Note on p_expires_at: a caller computing "the shortest expires_at among
    -- the grants a debit drew from" (spec section 4's refund rule) can hand
    -- back a timestamp that is ALREADY in the past by the time this call
    -- lands - e.g. the source grant expired in the gap between the original
    -- debit and this refund. That's not a bug: the new grant this insert
    -- creates is immediately eligible for the lazy sweep below on the very
    -- next spend_credits() call for this tenant (its `v_balance +=
    -- p_amount_micro` a few lines down transiently overstates the balance
    -- until then), which is exactly the same self-correction invariant 3
    -- relies on everywhere else, and only reachable now that a shortfall no
    -- longer discards the sweep that would catch it (this migration).
    insert into credit_grants (tenant_id, actor_id, actor_type, grant_type,
                               amount_micro, expires_at)
      values (p_tenant, p_actor, p_actor_type,
              coalesce(p_grant_type, case when p_kind = 'grant' then 'admin' else 'refund' end),
              p_amount_micro, p_expires_at)
      returning id into v_grant_id;

    v_balance := v_balance + p_amount_micro;
    insert into credit_ledger (tenant_id, actor_id, actor_type, grant_id, kind,
                               amount_micro, balance_after_micro, job_id, job_type,
                               rate_id, rate_version, idempotency_key, seq, reason)
      values (p_tenant, p_actor, p_actor_type, v_grant_id, p_kind,
              p_amount_micro, v_balance, p_job_id, p_job_type,
              p_rate_id, p_rate_version, p_key, 0, p_reason);

    update credit_accounts
       set balance_micro = v_balance, updated_at = now()
     where tenant_id = p_tenant;
    new_balance := v_balance;
  end if;
  -- p_amount_micro = 0: nothing further to do; new_balance already holds the
  -- swept balance, which was already persisted above.
end $$;
