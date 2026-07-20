import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Archive, Mail, Settings as SettingsIcon, Users } from "lucide-react";
import { PageHeader } from "../components/Workspace";
import { ArrIntegrationTrigger } from "../features/arr/ArrIntegrationTrigger";
import {
  AutoSyncSettings,
  LoadingAutoSyncSettings,
} from "../features/settings/AutoSyncSettings";
import { DebouncedDaysInput } from "../features/settings/DebouncedDaysInput";
import {
  LoadingDaysInput,
  SettingRow,
  SettingsSection,
} from "../features/settings/SettingsSection";
import { api } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";
import { requireAuth } from "../lib/requireAuth";

const MAX_INACTIVITY_DAYS = 36_500;
const MIN_USER_ACTIVITY_RETENTION_DAYS = 30;

export const Route = createFileRoute("/settings")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: SettingsPage,
});

function SettingsPage() {
  const { data } = useQuery({
    queryKey: queryKeys.settings.all,
    queryFn: api.settings.get,
  });
  const { data: latestSuccessfulSync, isPending: latestSuccessPending } =
    useQuery({
      queryKey: queryKeys.sync.latestSuccess,
      queryFn: api.sync.latestSuccess,
    });
  const lastSuccessfulSyncAt = latestSuccessPending
    ? undefined
    : (latestSuccessfulSync?.finishedAt ?? null);

  return (
    <div className="workspace-page settings-page space-y-6 max-w-5xl">
      <PageHeader
        eyebrow="Application preferences"
        title="Settings"
        description="Tune automatic sync, library analysis, user activity, and media-manager integrations."
        icon={SettingsIcon}
        actions={<ArrIntegrationTrigger />}
      />
      {/* Renders the Sonarr/Radarr dialog only while /settings/sonarr-radarr is
          active; see that route and ArrIntegrationDialog. */}
      <Outlet />

      <div className="settings-sections">
        {data ? (
          <AutoSyncSettings
            settings={data}
            lastSuccessfulSyncAt={lastSuccessfulSyncAt}
          />
        ) : (
          <LoadingAutoSyncSettings />
        )}

        <SettingsSection
          icon={Archive}
          tone="primary"
          title="Stale content"
          description="Control when unwatched library items become candidates for review."
        >
          <SettingRow
            title="Default minimum age for never-watched items"
            description="Unwatched items added within this many days are not considered stale. Libraries without their own override use this default."
          >
            {data ? (
              <DebouncedDaysInput
                initialDays={data.staleMinAgeDays}
                mutationFn={(value) =>
                  api.settings.update({ staleMinAgeDays: value })
                }
                getSavedValue={(updated) => updated.staleMinAgeDays}
              />
            ) : (
              <LoadingDaysInput label="Loading default minimum item age" />
            )}
          </SettingRow>
        </SettingsSection>

        <SettingsSection
          icon={Users}
          tone="accent"
          title="User activity"
          description="Define inactivity and how long detailed playback observations are retained."
        >
          <SettingRow
            title="Inactive user threshold"
            description="Users who haven't watched anything in at least this many days are flagged inactive on the Users page."
          >
            {data ? (
              <DebouncedDaysInput
                initialDays={data.inactiveUserDays}
                mutationFn={(value) =>
                  api.settings.update({ inactiveUserDays: value })
                }
                getSavedValue={(updated) => updated.inactiveUserDays}
                invalidateQueryKey={queryKeys.users.all}
                maxDays={MAX_INACTIVITY_DAYS}
              />
            ) : (
              <LoadingDaysInput label="Loading inactive user threshold" />
            )}
          </SettingRow>
          <SettingRow
            title="User activity retention"
            description="Keep user IP, device, and playback observations for at least the full 30-day sharing-risk window. Set to 0 to keep them forever."
          >
            {data ? (
              <DebouncedDaysInput
                initialDays={data.ipHistoryRetentionDays}
                mutationFn={(value) =>
                  api.settings.update({ ipHistoryRetentionDays: value })
                }
                getSavedValue={(updated) => updated.ipHistoryRetentionDays}
                minimumNonZero={MIN_USER_ACTIVITY_RETENTION_DAYS}
                invalidateQueryKey={queryKeys.users.all}
              />
            ) : (
              <LoadingDaysInput label="Loading user activity retention" />
            )}
          </SettingRow>
        </SettingsSection>

        <SettingsSection
          icon={Mail}
          tone="secondary"
          title="Invitations"
          description="Choose when unanswered Plex invitations need attention."
        >
          <SettingRow
            title="Pending invitation threshold"
            description="Pending Plex invitations at least this old are highlighted for follow-up on the Users page."
          >
            {data ? (
              <DebouncedDaysInput
                initialDays={data.pendingInviteStaleDays}
                mutationFn={(value) =>
                  api.settings.update({ pendingInviteStaleDays: value })
                }
                getSavedValue={(updated) => updated.pendingInviteStaleDays}
                invalidateQueryKey={queryKeys.users.invitations}
                maxDays={MAX_INACTIVITY_DAYS}
              />
            ) : (
              <LoadingDaysInput label="Loading pending invitation threshold" />
            )}
          </SettingRow>
          <SettingRow
            title="Overdue invitation threshold"
            description="Pending invitations at least this old are marked overdue. This must be at least the pending invitation threshold."
          >
            {data ? (
              <DebouncedDaysInput
                initialDays={data.pendingInviteCriticalDays}
                mutationFn={(value) =>
                  api.settings.update({ pendingInviteCriticalDays: value })
                }
                getSavedValue={(updated) => updated.pendingInviteCriticalDays}
                invalidateQueryKey={queryKeys.users.invitations}
                maxDays={MAX_INACTIVITY_DAYS}
              />
            ) : (
              <LoadingDaysInput label="Loading overdue invitation threshold" />
            )}
          </SettingRow>
        </SettingsSection>
      </div>
    </div>
  );
}
