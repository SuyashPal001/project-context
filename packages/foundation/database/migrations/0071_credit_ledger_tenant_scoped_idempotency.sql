-- Tenant-scope the credit idempotency namespace.
--
-- 0070 checked replay with `where idempotency_key = p_key` and backstopped it with a
-- unique index on (idempotency_key, seq) alone. Ops top-up keys are operator-supplied
-- and free-form (spec section 5), so a human-chosen key like 'aug-promo' reused for a
-- second tenant hit this: the second call locks its OWN account row (no contention),
-- the replay check matches the FIRST tenant's ledger row on the key string alone, and
-- the function returns tenant B's unchanged balance with no grant applied and no
-- error. A silent credit loss, in the single writer of every balance.
--
-- Fix forward rather than editing 0070 in place: its journal entry and drizzle
-- snapshot are already consistent with it. The function body below is 0070's,
-- unchanged except for the tenant predicate on the replay select.

DROP INDEX IF EXISTS "credit_ledger_key_seq_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_tenant_key_seq_uq" ON "credit_ledger" USING btree ("tenant_id","idempotency_key","seq");--> statement-breakpoint
create or replace function spend_credits(
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
  p_reason       text    default null
) returns bigint
language plpgsql
as $$
declare
  v_balance   bigint;
  v_remaining bigint;
  v_take      bigint;
  v_seq       integer := 0;
  v_grant     record;
  v_grant_id  uuid;
  v_dummy     bigint;
begin
  insert into credit_accounts (tenant_id) values (p_tenant) on conflict do nothing;

  select balance_micro into v_balance
    from credit_accounts
   where tenant_id = p_tenant
     for update;

  -- Replay check AFTER the lock: concurrent duplicates serialize into a clean
  -- replay instead of one of them dying on the unique index.
  select balance_after_micro into v_dummy
    from credit_ledger
   where tenant_id = p_tenant
     and idempotency_key = p_key
   order by seq desc
   limit 1;
  if found then
    return v_balance;
  end if;

  -- Lazy expiry under the same lock (invariant 3). Keeps balance_micro equal to
  -- the sum of live grant remainders at all times, not just after the cron.
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

  if p_amount_micro < 0 then
    v_remaining := -p_amount_micro;

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
      v_balance   := v_balance - v_take;
      v_remaining := v_remaining - v_take;
      insert into credit_ledger (tenant_id, actor_id, actor_type, grant_id, kind,
                                 amount_micro, balance_after_micro, job_id, job_type,
                                 rate_id, rate_version, idempotency_key, seq, reason)
        values (p_tenant, p_actor, p_actor_type, v_grant.id, p_kind,
                -v_take, v_balance, p_job_id, p_job_type,
                p_rate_id, p_rate_version, p_key, v_seq, p_reason);
      v_seq := v_seq + 1;
    end loop;

    if v_remaining > 0 then
      raise exception 'INSUFFICIENT_CREDITS'
        using errcode = 'P0001',
              detail  = format('short by %s micro', v_remaining);
    end if;

  elsif p_amount_micro > 0 then
    -- A credit ALWAYS creates a new grant. Never un-spend an old one: it may have
    -- expired, and the credits would then sit in the balance where FIFO cannot
    -- reach them (invariant 3).
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
  end if;

  update credit_accounts
     set balance_micro = v_balance, updated_at = now()
   where tenant_id = p_tenant;

  return v_balance;
end $$;
