-- The public pricing page reads current plan versions without signing in.
grant select on public.plans, public.plan_versions to anon;
create policy plans_public on public.plans for select to anon using (true);
create policy planv_public on public.plan_versions for select to anon using (true);
