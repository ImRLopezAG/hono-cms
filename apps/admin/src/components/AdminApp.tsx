// AdminApp barrel: re-exports the decomposed admin views and helpers so existing
// route imports (`../components/AdminApp`) and tests resolve unchanged.

export { AdminApp } from "./views/AdminAppRoot";
export { AppFrame } from "./views/AppFrame";
export {
  CONTENT_PAGE_SIZE,
  EDITOR_HOTKEYS,
  SHELL_HOTKEYS
} from "./views/shared";

export {
  authRedirectForPath,
  authRedirectForStoredToken,
  contentRouteStateFromParams,
  isAdminAuthRoute,
  mediaRouteStateFromParams,
  readStoredAdminAuthToken,
  shouldBlockAdminNavigation,
  type ContentRouteState,
  type MediaRouteState
} from "./views/auth-helpers";

export {
  apiKeysFromQuery,
  auditEntriesFromQuery,
  authSessionsFromQuery,
  contentRecordsFromQuery,
  contentSelectionKey,
  editorMutationErrorMessage,
  emptySchemaMetadata,
  healthReportFromQuery,
  i18nStatusFromQuery,
  mediaFromQuery,
  organizationFromQuery,
  organizationInvitationsFromQuery,
  organizationMembersFromQuery,
  relationRecordsFromQuery,
  removeCollectionSelection,
  schemaMetadataFromQuery,
  selectedItemsByCollection,
  toggleContentSelection,
  toggleVisibleContentSelection,
  updateContentListRecords,
  webhooksFromQuery
} from "./views/query-helpers";

export { ContentWorkspace } from "./views/ContentWorkspace";
export { HealthView } from "./views/HealthView";
export { SettingsShell } from "./views/SettingsShell";
export { AuditView, auditLogOptionsFromForm } from "./views/AuditView";
export {
  WebhooksView,
  isRetryableWebhookDelivery,
  selectedWebhook,
  webhookInputFromForm
} from "./views/WebhooksView";
export {
  ApiKeysView,
  apiKeyInputFromForm,
  selectedApiKey
} from "./views/ApiKeysView";
export {
  SessionsView,
  removeAuthSession,
  sessionRevokeToken
} from "./views/SessionsView";
export { RolesView } from "./views/RolesView";
export {
  AuthView,
  authActionInputFromForm,
  type AuthViewKind
} from "./views/AuthView";
export {
  ContentTypesView,
  contentTypeChangePreview,
  contentTypeFieldDraftsFromFields,
  contentTypeFieldsFromDrafts,
  contentTypeGenerationPreview,
  contentTypeInputFromForm,
  contentTypeWriteSummary,
  copyGeneratedSnippet,
  parseContentTypeOptions,
  validateContentTypeFieldDrafts,
  type ContentTypeChangePreview,
  type ContentTypeGenerationPreview
} from "./views/ContentTypesView";
export {
  I18nView,
  i18nBackfillInputFromForm,
  localizedCollectionOptions
} from "./views/I18nView";
export {
  OrganizationSettingsView,
  organizationInputFromForm
} from "./views/OrganizationSettingsView";
export {
  OrganizationMembersView,
  memberInputFromForm
} from "./views/OrganizationMembersView";
export {
  OrganizationInvitationsView,
  invitationInputFromForm
} from "./views/OrganizationInvitationsView";
export { MediaView } from "./views/MediaView";
