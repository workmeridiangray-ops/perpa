-- Workflow helpers called by the app. All run as the caller's rights where possible;
-- definer is used only for copying and checks the caller's role first.

create function public.new_version(p_estimate uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare b uuid; latest public.estimate_versions; v uuid;
begin
  select business_id into b from public.estimates where id = p_estimate;
  if b is null or not app.has_role(b, 'owner', 'manager', 'staff') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into latest from public.estimate_versions where estimate_id = p_estimate order by version desc limit 1;
  if latest.status in ('draft', 'pending_approval') then raise exception 'the latest revision is still open'; end if;
  insert into public.estimate_versions (business_id, estimate_id, version, discount_bps, exclusions)
    values (b, p_estimate, latest.version + 1, latest.discount_bps, latest.exclusions) returning id into v;
  insert into public.estimate_lines (business_id, version_id, kind, description, role_label, hours_centi, rate_paise, quantity_centi)
    select business_id, v, kind, description, role_label, hours_centi, rate_paise, quantity_centi from public.estimate_lines where version_id = latest.id;
  if app.has_role(b, 'owner', 'manager') then
    insert into public.estimate_line_costs (line_id, business_id, cost_rate_paise)
      select n.id, n.business_id, c.cost_rate_paise
      from public.estimate_lines o join public.estimate_line_costs c on c.line_id = o.id
      join public.estimate_lines n on n.version_id = v and n.description = o.description and n.rate_paise = o.rate_paise
      where o.version_id = latest.id
      on conflict do nothing;
  end if;
  return v;
end $$;

create function public.start_project(p_engagement uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare e public.engagements; p uuid;
begin
  select * into e from public.engagements where id = p_engagement;
  if e.id is null or not app.has_role(e.business_id, 'owner', 'manager') then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.projects (business_id, engagement_id, name) values (e.business_id, e.id, e.name) returning id into p;
  update public.engagements set status = 'active' where id = e.id;
  return p;
end $$;

revoke all on function public.new_version(uuid), public.start_project(uuid) from public, anon;
grant execute on function public.new_version(uuid), public.start_project(uuid) to authenticated;
