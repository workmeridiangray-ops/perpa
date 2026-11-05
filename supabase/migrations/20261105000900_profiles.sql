-- Every auth user gets a profile; owners/managers can read colleagues' names and emails.
create function app.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name) values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function app.handle_new_user();

create policy profiles_colleagues on public.profiles for select to authenticated
  using (exists (select 1 from public.memberships m where m.user_id = profiles.id and app.has_role(m.business_id, 'owner', 'manager')));
