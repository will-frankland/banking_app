"use server";

import { ID, Query } from "node-appwrite";
import { createAdminClient, createSessionClient } from "../appwrite";
import { cookies } from "next/headers";
import { encryptId, extractCustomerIdFromUrl, getErrorMessage, parseStringify } from "../utils";
import {
  CountryCode,
  ProcessorTokenCreateRequest,
  ProcessorTokenCreateRequestProcessorEnum,
  Products,
} from "plaid";
import { plaidClient } from "../plaid";
import { revalidatePath } from "next/cache";
import { addFundingSource, createDwollaCustomer } from "./dwolla.actions";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_USER_COLLECTION_ID: USER_COLLECTION_ID,
  APPWRITE_BANK_COLLECTION_ID: BANK_COLLECTION_ID,
} = process.env;

const setSessionCookie = (session: { secret: string; expire?: string }) => {
  const expires = session.expire ? new Date(session.expire) : undefined;

  cookies().set("appwrite-session", session.secret, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    ...(expires && !Number.isNaN(expires.getTime()) ? { expires } : {}),
  });
};

export const getUserInfo = async({ userId }: getUserInfoProps) => {
  const { database } = await createAdminClient();

  const user = await database.listDocuments(
    DATABASE_ID!,
    USER_COLLECTION_ID!,
    [Query.equal('userId', [userId])]
  )

  if (!user.documents[0]) return null;

  return parseStringify(user.documents[0])
}

export const signIn = async ({ email, password }: signInProps) => {
  try {
    const { account } = await createAdminClient();

    const session = await account.createEmailPasswordSession(email, password);

    if (!session?.secret) {
      return {
        ok: false as const,
        error:
          "Appwrite created a session but did not return a secret. Check that NEXT_APPWRITE_KEY is a valid server API key with the sessions.write scope.",
      };
    }

    setSessionCookie(session);

    let user = await getUserInfo({ userId: session.userId });

    if (!user) {
      user = await createProfileForAuthUser(session.userId);
    }

    return { ok: true as const, user };
  } catch (error) {
    console.error("Error", error);
    return { ok: false as const, error: getErrorMessage(error) };
  }
};

const createProfileForAuthUser = async (userId: string) => {
  const { database, user } = await createAdminClient();
  const authUser = await user.get(userId);
  const [firstName, ...rest] = (authUser.name || "Guest User").split(" ");

  const created = await database.createDocument(
    DATABASE_ID!,
    USER_COLLECTION_ID!,
    ID.unique(),
    {
      firstName: firstName || "Guest",
      lastName: rest.join(" ") || "User",
      address1: "",
      city: "",
      state: "",
      postalCode: "",
      dateOfBirth: "",
      ssn: "",
      email: authUser.email,
      userId,
      dwollaCustomerId: "",
      dwollaCustomerUrl: "",
    }
  );

  return parseStringify(created);
};

export const signUp = async ({ password, ...userData }: SignUpParams) => {
  const { email, firstName, lastName } = userData;

  try {
    const { account, database, user } = await createAdminClient();

    const newUserAccount = await account.create(
      ID.unique(),
      email,
      password,
      `${firstName} ${lastName}`
    );

    if (!newUserAccount) throw new Error("Error creating user");

    // This app has no email-verification screen. If the Appwrite project
    // requires a verified email, session creation fails unless we mark it here.
    try {
      await user.updateEmailVerification(newUserAccount.$id, true);
    } catch (error) {
      console.error("Could not mark email as verified", error);
    }

    let dwollaCustomerId = "";
    let dwollaCustomerUrl = "";
    let warning = "";

    try {
      const createdCustomerUrl = await createDwollaCustomer({
        ...userData,
        type: "personal",
      });

      if (!createdCustomerUrl) {
        throw new Error("Dwolla did not return a customer");
      }

      dwollaCustomerUrl = createdCustomerUrl;
      dwollaCustomerId = extractCustomerIdFromUrl(createdCustomerUrl);
    } catch (error) {
      console.error("Dwolla customer creation failed", error);
      warning =
        "Your login was created, but bank transfers need a working Dwolla sandbox key. You can still open the dashboard.";
    }

    const newUser = await database.createDocument(
      DATABASE_ID!,
      USER_COLLECTION_ID!,
      ID.unique(),
      {
        ...userData,
        userId: newUserAccount.$id,
        dwollaCustomerId,
        dwollaCustomerUrl,
      }
    );

    const session = await account.createEmailPasswordSession(email, password);

    if (!session?.secret) {
      return {
        ok: false as const,
        error:
          "Your account was created, but Appwrite did not return a session secret. Check that NEXT_APPWRITE_KEY has the sessions.write scope, then sign in.",
      };
    }

    setSessionCookie(session);

    return { ok: true as const, user: parseStringify(newUser), warning };
  } catch (error) {
    console.error("Error", error);
    return { ok: false as const, error: getErrorMessage(error) };
  }
};

export async function getLoggedInUser() {
  try {
    const { account } = await createSessionClient();
    const result = await account.get();

    return await getUserInfo({ userId: result.$id });
  } catch (error) {
    return null;
  }
}

export const logoutAccount = async () => {
  try {
    const { account } = await createSessionClient();
    await account.deleteSession("current");
  } catch (error) {
    console.error("Error", error);
  }

  cookies().delete("appwrite-session");
  return true;
};

export const createLinkToken = async (user: User) => {
  try {
    const tokenParams = {
      user: {
        client_user_id: user.$id,
      },
      client_name: `${user.firstName} ${user.lastName}`,
      products: ["auth"] as Products[],
      language: "en",
      country_codes: ["US"] as CountryCode[],
    };
    const response = await plaidClient.linkTokenCreate(tokenParams);

    return parseStringify({ linkToken: response.data.link_token });
  } catch (error) {
    console.log(error);
  }
};

// Create a bank account as a document in Appwrite
export const createBankAccount = async ({
  userId,
  bankId,
  accountId,
  accessToken,
  fundingSourceUrl,
  shareableId,
}: createBankAccountProps) => {
  try {
    const { database } = await createAdminClient();

    const bankAccount = await database.createDocument(
      DATABASE_ID!,
      BANK_COLLECTION_ID!,
      ID.unique(),
      {
        userId,
        bankId,
        accountId,
        accessToken,
        fundingSourceUrl,
        shareableId,
      }
    )

    return parseStringify(bankAccount);
  } catch (error) {}
};

// This function exchanges a public token for an access token and item ID
export const exchangePublicToken = async ({
  publicToken,
  user,
}: exchangePublicTokenProps) => {
  try {
    // Exchange public token for access token and item ID
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });

    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    // Get account information from Plaid using the access token
    const accountsResponse = await plaidClient.accountsGet({
      access_token: accessToken,
    });

    const accountData = accountsResponse.data.accounts[0];

    // Create a processor token for Dwolla using the access token and account ID
    const request: ProcessorTokenCreateRequest = {
      access_token: accessToken,
      account_id: accountData.account_id,
      processor: "dwolla" as ProcessorTokenCreateRequestProcessorEnum,
    };

    const processorTokenResponse = await plaidClient.processorTokenCreate(
      request
    );
    const processorToken = processorTokenResponse.data.processor_token;

    // Create a funding source URL for the account using the Dwolla customer ID, processor token, and bank name
    const fundingSourceUrl = await addFundingSource({
      dwollaCustomerId: user.dwollaCustomerId,
      processorToken,
      bankName: accountData.name,
    });

    // If the funding source URL is not created, throw an error
    if (!fundingSourceUrl) throw Error;

    // Create a bank account using the user ID, item ID, account ID, access token, funding source URL, and shareableId ID
    await createBankAccount({
      userId: user.$id,
      bankId: itemId,
      accountId: accountData.account_id,
      accessToken,
      fundingSourceUrl,
      shareableId: encryptId(accountData.account_id),
    });

    // Revalidate the path to reflect the changes
    revalidatePath("/");

    // Return a success message
    return parseStringify({
      publicTokenExchange: "complete",
    });
  } catch (error) {
    console.error("An error occurred while creating exchanging token:", error);
  }
};

export const getBanks = async ({ userId }: getBanksProps) => {
  try {
    const { database } = await createAdminClient();

    const banks = await database.listDocuments(
      DATABASE_ID!,
      BANK_COLLECTION_ID!,
      [Query.equal('userId', [userId])]
    )

    return parseStringify(banks.documents)
  } catch (error) {
    console.log(error)
  }
}

export const getBank = async ({ documentId }: getBankProps) => {
  try {
    const { database } = await createAdminClient();

    const bank = await database.listDocuments(
      DATABASE_ID!,
      BANK_COLLECTION_ID!,
      [Query.equal('$id', [documentId])]
    )

    return parseStringify(bank.documents[0])
  } catch (error) {
    console.log(error)
  }
}

export const getBankByAccountId = async ({ accountId }: getBankByAccountIdProps) => {
  try {
    const { database } = await createAdminClient();

    const bank = await database.listDocuments(
      DATABASE_ID!,
      BANK_COLLECTION_ID!,
      [Query.equal('accountId', [accountId])]
    )

    if(bank.total !== 1) return null;

    return parseStringify(bank.documents[0])
  } catch (error) {
    console.log(error)
  }
}
