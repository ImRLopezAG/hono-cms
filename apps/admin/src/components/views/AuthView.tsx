import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useAtom } from "jotai";
import { Workflow } from "lucide-react";
import { type ReactElement } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AuthActionInput } from "../../lib/api-client";
import { authTokenAtom } from "../../state/admin-atoms";
import { useClient } from "./shared";

export type AuthViewKind =
  | "login"
  | "register"
  | "forgot-password"
  | "magic-link"
  | "verify-email"
  | "2fa-setup"
  | "2fa-verify";

type AuthViewConfig = {
  heading: string;
  subheading: string;
  action: string;
  submit: string;
  success: string;
  fields: Array<keyof AuthActionInput>;
};

function authViewConfig(kind: AuthViewKind): AuthViewConfig {
  const configs: Record<AuthViewKind, AuthViewConfig> = {
    login: {
      heading: "Welcome!",
      subheading: "Log in to your Hono CMS account",
      action: "login",
      submit: "Sign in",
      success: "Session started.",
      fields: ["email", "password", "token"]
    },
    register: {
      heading: "Create your account",
      subheading: "Set up your Hono CMS administrator account",
      action: "register",
      submit: "Let's start",
      success: "Registration accepted.",
      fields: ["name", "email", "password"]
    },
    "forgot-password": {
      heading: "Password Recovery",
      subheading: "Enter your email address and we'll send a reset link",
      action: "forgot-password",
      submit: "Send Email",
      success: "Reset link sent. Check your inbox.",
      fields: ["email"]
    },
    "magic-link": {
      heading: "Magic link sign-in",
      subheading: "We'll email you a one-time sign-in link",
      action: "magic-link",
      submit: "Send magic link",
      success: "Magic link sent. Check your inbox.",
      fields: ["email"]
    },
    "verify-email": {
      heading: "Verify your email",
      subheading: "Enter the verification token from your email",
      action: "verify-email",
      submit: "Verify email",
      success: "Email verified successfully.",
      fields: ["token"]
    },
    "2fa-setup": {
      heading: "Enable two-factor auth",
      subheading: "Confirm your authenticator app enrollment",
      action: "2fa/setup",
      submit: "Enable 2FA",
      success: "Two-factor authentication enabled.",
      fields: ["code"]
    },
    "2fa-verify": {
      heading: "Two-factor verification",
      subheading: "Enter the code from your authenticator app",
      action: "2fa/verify",
      submit: "Verify code",
      success: "Second factor accepted.",
      fields: ["code"]
    }
  };
  return configs[kind];
}

type DefaultFormValues = {
  name: string;
  email: string;
  password: string;
  token: string;
  code: string;
};

function defaultFormValues(): DefaultFormValues {
  return { name: "", email: "", password: "", token: "", code: "" };
}

export function authActionInputFromForm(
  kind: AuthViewKind,
  source: FormData | DefaultFormValues
): AuthActionInput {
  const get = (key: string): string => {
    if (source instanceof FormData) return String(source.get(key) ?? "").trim();
    return String(source[key as keyof DefaultFormValues] ?? "").trim();
  };
  const config = authViewConfig(kind);
  const token = get("token");
  if (kind === "login" && token) return { token };
  const input: AuthActionInput = {};
  for (const field of config.fields) {
    const value = get(field);
    if (value) input[field] = value;
  }
  return input;
}

/* -------------------------------------------------------------------------- */
/*  AuthView                                                                  */
/*                                                                            */
/*  Mirrors Strapi v5's UnauthenticatedLayout chrome:                         */
/*    - full-bleed light bg (#f6f6f9, already supplied by AppFrame wrapper)   */
/*    - brand mark above the card                                             */
/*    - centered ~448px white card with rounded-md + shadow-md + p-10         */
/*    - 24px bold heading + 14px neutral600 subheading                        */
/*    - field labels above shadcn Inputs, indigo focus ring                   */
/*    - full-width indigo submit button                                       */
/*    - link footer outside the card                                          */
/* -------------------------------------------------------------------------- */
export function AuthView({ kind }: { kind: AuthViewKind }): ReactElement {
  const client = useClient();
  const navigate = useNavigate();
  const [, setToken] = useAtom(authTokenAtom);
  const config = authViewConfig(kind);

  const mutation = useMutation({
    mutationFn: (input: AuthActionInput) => client.authAction(config.action, input),
    onSuccess: (result) => {
      if (result.token) setToken(result.token);
    }
  });

  const form = useForm({
    defaultValues: defaultFormValues(),
    onSubmit: async ({ value }) => {
      mutation.reset();
      await mutation.mutateAsync(authActionInputFromForm(kind, value));
    }
  });

  const errorMessage =
    mutation.error instanceof Error
      ? mutation.error.message
      : mutation.error
        ? "An unexpected error occurred."
        : null;
  const successMessage = mutation.data?.ok ? (mutation.data.message ?? config.success) : null;

  return (
    <div className="flex w-full flex-col items-center gap-6 px-4 py-10">
      {/* Brand mark above the card — matches AppFrame Rail 1 BrandMark exactly */}
      <span
        className="inline-flex size-8 items-center justify-center rounded-[6px] bg-[#4945ff] text-white"
        aria-hidden
      >
        <Workflow size={16} />
      </span>

      {/* Centered white card */}
      <div className="w-full max-w-[448px] rounded-md bg-white p-10 shadow-md">
        {/* Card header */}
        <div className="flex flex-col items-center gap-2 pb-6 text-center">
          <h1 className="text-[24px] font-bold leading-tight text-[#32324d]">{config.heading}</h1>
          <p className="text-[14px] leading-snug text-[#666687]">{config.subheading}</p>
        </div>

        {/* Error alert sits above the form fields when the mutation rejects */}
        {errorMessage && (
          <Alert variant="destructive" className="mb-5">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        {/* Success alert (e.g. forgot-password confirmation, magic-link sent) */}
        {successMessage && (
          <Alert className="mb-5 border-[#c6f0c2] bg-[#eafbe7] text-[#328048]">
            <AlertDescription>{successMessage}</AlertDescription>
          </Alert>
        )}

        {/* Form */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
          className="flex flex-col gap-6"
          noValidate
        >
          {config.fields.includes("name") && (
            <form.Field name="name">
              {(field) => (
                <FieldShell htmlFor="auth-name" label="Full name">
                  <Input
                    id="auth-name"
                    name="name"
                    autoComplete="name"
                    placeholder="Kai Doe"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.currentTarget.value)}
                    required
                    className={inputClass}
                  />
                </FieldShell>
              )}
            </form.Field>
          )}

          {config.fields.includes("email") && (
            <form.Field name="email">
              {(field) => (
                <FieldShell htmlFor="auth-email" label="Email">
                  <Input
                    id="auth-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="kai@doe.com"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.currentTarget.value)}
                    required={kind !== "login"}
                    className={inputClass}
                  />
                </FieldShell>
              )}
            </form.Field>
          )}

          {config.fields.includes("password") && (
            <form.Field name="password">
              {(field) => (
                <FieldShell htmlFor="auth-password" label="Password">
                  <Input
                    id="auth-password"
                    name="password"
                    type="password"
                    autoComplete={kind === "login" ? "current-password" : "new-password"}
                    placeholder=""
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.currentTarget.value)}
                    required={kind !== "login"}
                    className={inputClass}
                  />
                </FieldShell>
              )}
            </form.Field>
          )}

          {/* API token alternative for login — separated from password */}
          {config.fields.includes("token") && kind !== "login" && (
            <form.Field name="token">
              {(field) => (
                <FieldShell htmlFor="auth-token" label="API token">
                  <Input
                    id="auth-token"
                    name="token"
                    autoComplete="one-time-code"
                    placeholder="sk-..."
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.currentTarget.value)}
                    className={inputClass}
                  />
                </FieldShell>
              )}
            </form.Field>
          )}

          {config.fields.includes("code") && (
            <form.Field name="code">
              {(field) => (
                <FieldShell htmlFor="auth-code" label="Verification code">
                  <Input
                    id="auth-code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.currentTarget.value)}
                    required
                    className={inputClass}
                  />
                </FieldShell>
              )}
            </form.Field>
          )}

          <Button
            type="submit"
            disabled={mutation.isPending}
            className="h-10 w-full rounded-md bg-[#4945ff] font-semibold text-white shadow-none hover:bg-[#7b79ff] focus-visible:ring-2 focus-visible:ring-[#4945ff]/40"
          >
            {config.submit}
          </Button>
        </form>

        {/* Forgot-password link sits centered below the form on the login card */}
        {kind === "login" && (
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              className="rounded text-[14px] font-semibold text-[#4945ff] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4945ff]/30"
              onClick={() => void navigate({ to: "/forgot-password" })}
            >
              Forgot your password?
            </button>
          </div>
        )}
      </div>

      {/* Footer link OUTSIDE the white card */}
      <CardFooter kind={kind} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

const inputClass =
  "h-10 rounded-md border-[#dcdce4] bg-white text-[14px] text-[#32324d] placeholder:text-[#a5a5ba] focus-visible:border-[#4945ff] focus-visible:ring-2 focus-visible:ring-[#4945ff]/30";

function FieldShell({
  htmlFor,
  label,
  children
}: {
  htmlFor: string;
  label: string;
  children: ReactElement;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-[13px] font-semibold text-[#32324d]">
        {label}
      </Label>
      {children}
    </div>
  );
}

function CardFooter({ kind }: { kind: AuthViewKind }): ReactElement | null {
  const navigate = useNavigate();

  if (kind === "login") {
    return (
      <p className="text-center text-[14px] text-[#666687]">
        Don't have an account?{" "}
        <button
          type="button"
          className="font-semibold text-[#4945ff] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4945ff]/30 rounded"
          onClick={() => void navigate({ to: "/register" })}
        >
          Sign up
        </button>
      </p>
    );
  }

  if (kind === "register") {
    return (
      <p className="text-center text-[14px] text-[#666687]">
        Already have an account?{" "}
        <button
          type="button"
          className="font-semibold text-[#4945ff] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4945ff]/30 rounded"
          onClick={() => void navigate({ to: "/login" })}
        >
          Sign in
        </button>
      </p>
    );
  }

  if (kind === "forgot-password" || kind === "magic-link") {
    return (
      <p className="text-center text-[14px] text-[#666687]">
        <button
          type="button"
          className="font-semibold text-[#4945ff] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4945ff]/30 rounded"
          onClick={() => void navigate({ to: "/login" })}
        >
          Ready to sign in?
        </button>
      </p>
    );
  }

  if (kind === "2fa-verify" || kind === "2fa-setup" || kind === "verify-email") {
    return (
      <p className="text-center text-[14px] text-[#666687]">
        <button
          type="button"
          className="font-semibold text-[#4945ff] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4945ff]/30 rounded"
          onClick={() => void navigate({ to: "/login" })}
        >
          Back to login
        </button>
      </p>
    );
  }

  return null;
}
