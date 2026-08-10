import UserListPage from './UserListPage';
export default function AdsManagersPage() {
  return (
    <UserListPage
      role="ads_manager"
      title="Ads Managers"
      emptyHint="Add an Ads Manager to run paid ads / GMV Max. An Operation Lead then picks which brands they manage in Settings → Ads Manager Brands — that list is also what they can see."
    />
  );
}
