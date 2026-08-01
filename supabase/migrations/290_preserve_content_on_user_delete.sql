-- ============================================================
-- 290 — A deleted user must NEVER take their content with them.
--
-- The chain profiles.id → auth.users(id) ON DELETE CASCADE (mig 001) means a
-- HARD delete of an auth user (Supabase Auth dashboard, auth.admin.deleteUser
-- without soft-delete, a manual SQL delete, or a bug) cascades to the profile
-- row — and from there, several content tables were ON DELETE CASCADE and would
-- be silently destroyed: kb_articles, resources, brand tasks, and their comments/
-- attachments. (The app's normal delete-user SOFT-deletes, so this never fires in
-- practice — but the landmine is real. This is exactly the "docs vanished, no
-- trace" risk we just investigated.)
--
-- Fix: flip those content-authoring FKs to ON DELETE RESTRICT — the same guard
-- brands.owner_id and reports.author_id already use. Effect:
--   • Soft-delete (the sanctioned flow) is UNCHANGED — it never deletes the
--     profile row, so RESTRICT never triggers; content keeps full attribution.
--   • Any HARD delete of a user who has content now FAILS SAFELY (the delete is
--     refused) instead of cascade-wiping brand/KB/resource data.
-- Reports (author_id) and brands (owner_id) are already RESTRICT — left as-is;
-- delete-user reassigns owned brands to the Boss before finishing.
--
-- Also: wire kb_articles + resources into the audit log (mig 028) so future
-- edits/deletes capture the full before-row → traceable AND recoverable.
-- ============================================================

-- 1. Drop the existing (CASCADE) FKs on these content columns, by (table,column)
--    so we don't depend on the exact constraint name.
do $$
declare r record;
begin
  for r in
    select rel.relname as tbl, con.conname as name
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid = 'public.profiles'::regclass
       and array_length(con.conkey, 1) = 1
       and (rel.relname, att.attname) in (
         ('kb_articles','created_by'), ('resources','created_by'), ('tasks','assignee_id'),
         ('kb_comments','author_id'), ('task_comments','author_id'),
         ('task_attachments','uploader_id'), ('changes','submitted_by')
       )
  loop
    execute format('alter table public.%I drop constraint %I', r.tbl, r.name);
  end loop;
end $$;

-- 2. Re-add each as ON DELETE RESTRICT (columns stay NOT NULL — full attribution).
alter table public.kb_articles      add constraint kb_articles_created_by_fkey       foreign key (created_by)  references public.profiles(id) on delete restrict;
alter table public.resources        add constraint resources_created_by_fkey         foreign key (created_by)  references public.profiles(id) on delete restrict;
alter table public.tasks            add constraint tasks_assignee_id_fkey            foreign key (assignee_id) references public.profiles(id) on delete restrict;
alter table public.kb_comments      add constraint kb_comments_author_id_fkey        foreign key (author_id)   references public.profiles(id) on delete restrict;
alter table public.task_comments    add constraint task_comments_author_id_fkey      foreign key (author_id)   references public.profiles(id) on delete restrict;
alter table public.task_attachments add constraint task_attachments_uploader_id_fkey foreign key (uploader_id) references public.profiles(id) on delete restrict;
alter table public.changes          add constraint changes_submitted_by_fkey         foreign key (submitted_by) references public.profiles(id) on delete restrict;

-- 3. Audit + recoverability for KB and resources (reuse mig 028's audit_record()).
drop trigger if exists kb_articles_audit on public.kb_articles;
create trigger kb_articles_audit after insert or update or delete on public.kb_articles
  for each row execute function public.audit_record();
drop trigger if exists resources_audit on public.resources;
create trigger resources_audit after insert or update or delete on public.resources
  for each row execute function public.audit_record();

-- 4. Report the resulting on-delete rules (c=cascade, r=restrict, n=set null).
do $$
declare r record;
begin
  for r in
    select rel.relname as tbl, att.attname as col, con.confdeltype as del
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
     where con.contype = 'f' and con.confrelid = 'public.profiles'::regclass
       and (rel.relname, att.attname) in (
         ('kb_articles','created_by'), ('resources','created_by'), ('tasks','assignee_id'),
         ('kb_comments','author_id'), ('task_comments','author_id'),
         ('task_attachments','uploader_id'), ('changes','submitted_by')
       )
     order by rel.relname
  loop
    raise notice 'FK %.% on-delete=%  (expect r=restrict)', r.tbl, r.col, r.del;
  end loop;
end $$;

-- 5. SAFETY SELF-TEST: prove a content-authoring profile can no longer be deleted.
--    Attempts a delete in a subtransaction; a foreign_key_violation = PASS. If the
--    delete somehow SUCCEEDS, we abort the whole migration (nothing is committed).
do $$
declare v_uid uuid; v_deleted boolean := false;
begin
  select created_by into v_uid from public.kb_articles where created_by is not null limit 1;
  if v_uid is null then raise notice 'SAFETY TEST skipped (no KB author found)'; return; end if;
  begin
    delete from public.profiles where id = v_uid;   -- must be blocked by RESTRICT
    v_deleted := true;
  exception when foreign_key_violation then
    v_deleted := false;
  end;
  if v_deleted then
    raise exception 'SAFETY TEST FAILED: profile % with KB content was DELETABLE — content is not protected!', v_uid;
  end if;
  raise notice 'SAFETY TEST PASSED: deleting a content-authoring profile is blocked by RESTRICT (content preserved).';
end $$;
