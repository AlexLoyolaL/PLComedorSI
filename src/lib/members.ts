export type ResidencyStatus = "SAN_ISIDRO" | "FUERA_SAN_ISIDRO" | "SIN_VERIFICAR";

export type MemberProfile = {
  dni: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  address: {
    street: string;
    number: string;
    locality: string;
  };
  residencyStatus: ResidencyStatus;
  profileStatus: "COMPLETO" | "INCOMPLETO";
};

export type MemberAlert = {
  dni: string;
  active: boolean;
  message: string;
  level: "INFO" | "IMPORTANTE";
  validUntil?: string | null;
  createdAt?: any;
  createdBy?: { uid?: string; email?: string; name?: string };
  updatedAt?: any;
  updatedBy?: { uid?: string; email?: string; name?: string };
  removedAt?: any;
  removedBy?: { uid?: string; email?: string; name?: string };
};

export function emptyMemberProfile(dni = ""): MemberProfile {
  return {
    dni,
    firstName: "",
    lastName: "",
    birthDate: "",
    address: { street: "", number: "", locality: "" },
    residencyStatus: "SIN_VERIFICAR",
    profileStatus: "INCOMPLETO",
  };
}

export function memberProfileFromData(dni: string, data?: any): MemberProfile {
  const firstName = String(data?.firstName ?? data?.name ?? "");
  const lastName = String(data?.lastName ?? "");
  const birthDate = String(data?.birthDate ?? "");
  const address = {
    street: String(data?.address?.street ?? ""),
    number: String(data?.address?.number ?? ""),
    locality: String(data?.address?.locality ?? ""),
  };
  const residencyStatus: ResidencyStatus =
    data?.residencyStatus === "SAN_ISIDRO" || data?.residencyStatus === "FUERA_SAN_ISIDRO"
      ? data.residencyStatus
      : "SIN_VERIFICAR";
  const complete = Boolean(
    firstName.trim()
    && lastName.trim()
    && birthDate
    && address.street.trim()
    && address.number.trim()
    && address.locality.trim()
    && residencyStatus !== "SIN_VERIFICAR"
  );

  return {
    dni,
    firstName,
    lastName,
    birthDate,
    address,
    residencyStatus,
    profileStatus: complete ? "COMPLETO" : "INCOMPLETO",
  };
}

export function isMemberAlertActive(alert: MemberAlert | null, dateKey: string): alert is MemberAlert {
  return Boolean(alert?.active && (!alert.validUntil || alert.validUntil >= dateKey));
}

export function residencyLabel(status: ResidencyStatus) {
  if (status === "SAN_ISIDRO") return "Domicilio en San Isidro";
  if (status === "FUERA_SAN_ISIDRO") return "Domicilio fuera de San Isidro";
  return "Domicilio sin verificar";
}
