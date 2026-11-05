-- Private storage bucket for deliverable files. Object paths are "<business_id>/<project_id>/<file>".
-- Only runs where Supabase Storage exists; plain Postgres (used for rule tests) skips it.
do $$
begin
  if to_regclass('storage.buckets') is null then return; end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('deliverables', 'deliverables', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/csv'])
  on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = excluded.allowed_mime_types;

  execute $p$create policy deliverables_upload on storage.objects for insert to authenticated
    with check (bucket_id = 'deliverables' and app.has_role(((storage.foldername(name))[1])::uuid, 'owner', 'manager', 'staff'))$p$;
  -- Readable only if the caller can see the matching files row (RLS there decides: staff always, clients only for shared + clean).
  execute $p$create policy deliverables_read on storage.objects for select to authenticated
    using (bucket_id = 'deliverables' and exists (select 1 from public.files f where f.path = storage.objects.name))$p$;
end $$;
