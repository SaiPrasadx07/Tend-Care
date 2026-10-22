# Confidential computing for Tend: a feasibility assessment

**Status:** investigation only. Tend does **not** run in a Trusted Execution Environment (TEE), and nothing in this repository should be described as TEE-protected. This note records what a TEE could and couldn't do for Tend, and the smallest honest way to try one.

## 1. What needs protecting

| Data / processing | Where it lives today | Sensitivity |
|---|---|---|
| Care recipients, medications, schedules, dose events, notes ("Dad felt dizzy") | SQLite file on the host (`data/tend.db`) | Health information about identifiable people |
| Caregiver identities and bearer tokens; HMAC session secret | Environment variables / `.env` on the host | Credentials: whoever holds them can read and write the record |
| Conversation text and tool results | Process memory; sent to Amazon Bedrock when the Bedrock engine is on | Health information in free text |
| Pharmacy request drafts | Process memory and SQLite | Names, medications, pharmacy |

The core processing worth isolating is small: the MCP server's `CareService` (reads, writes, double-dose guard, refill state), the session-token signer, and the decryption of the database.

## 2. What a TEE would and wouldn't mitigate

**Would help with (when deployed and attested):**
- A host operator, compromised host OS or hypervisor-level attacker reading the record or the session secret out of memory or disk. In a TEE, memory is encrypted or isolated, and the database key is released only to code with a known measurement.
- Silent code substitution. Clients, or a key service, can check an attestation before trusting the server, so a modified server image doesn't get the key.
- Insider access to plaintext backups, if the database is encrypted with a key that only the attested enclave can unwrap.

**Would not help with:**
- **Anyone holding a valid caregiver token.** The TEE faithfully serves an authorized caller. Authorization, token hygiene and least privilege (viewer vs caregiver) remain the main controls.
- **Data sent to the model.** A Bedrock call leaves the enclave. Amazon Bedrock is a managed service with its own security commitments (AWS documents that prompts aren't shared with model providers or used to train base models), but it is not an enclave Tend can attest. Using it moves trust to AWS's service controls, not to hardware attestation.
- **Bugs in Tend's own code**: injection, logic errors, a tool that returns too much. The TEE runs whatever was measured, bugs included.
- **Side-channel attacks** against the TEE hardware, denial of service by the host (which still controls scheduling, networking and storage), and the browser and devices at the edges (the caregiver's phone, the Echo).
- **Alexa+ itself.** Speech is processed by Amazon's Alexa service before it reaches an MCP server; a TEE on Tend's side doesn't change that.

## 3. Candidate platforms and attestation

| Platform | Isolation | Attestation | Fit for Tend |
|---|---|---|---|
| **AWS Nitro Enclaves** | Isolated VM carved from an EC2 instance; no persistent storage, no external network, vsock to the parent only | Attestation document signed by the Nitro hypervisor, containing PCR measurements of the enclave image. **AWS KMS** can make `Decrypt` conditional on these PCRs (`kms:RecipientAttestation:*` condition keys). | **Best fit.** Tend is already AWS-oriented, and KMS-gated key release is exactly the database-key pattern. The parent instance must proxy HTTP and storage. |
| **AMD SEV-SNP** (EC2 instance types that support it, Azure and Google Cloud confidential VMs) | Whole VM, memory encrypted against the hypervisor | Signed SNP attestation report with the launch measurement; verification needs the AMD certificate chain | Simplest lift-and-shift: Node and SQLite run unchanged. Coarser trust boundary (the whole guest OS). |
| **Intel TDX** (Azure, Google Cloud confidential VMs) | Whole VM ("trust domain") | TD quote verified via Intel's attestation services | Similar to SEV-SNP. |
| **Google Confidential Space / Azure confidential containers** | Container workload in a confidential VM | Platform-issued attestation token (OIDC-style) usable in key-release policies | Good developer experience, but off-AWS for an AWS Builder entry. |
| **Confidential GPUs** (e.g. NVIDIA H100 confidential computing mode) | GPU memory protected, paired with a CPU TEE | GPU attestation via the vendor's service | Only relevant if Tend self-hosted a model. Not needed for Bedrock, and far beyond hackathon scope. |

## 4. How it would work with the other controls

- **Encryption at rest:** encrypt the SQLite file (or per-row fields) with a data key. Wrap that key with an AWS KMS key whose policy allows `Decrypt` only with a Nitro attestation whose image PCR matches the reviewed build. The parent instance only ever sees ciphertext.
- **Key management:** a KMS customer-managed key with key rotation; separate keys for the database and the session-token secret. The PCR value in the key policy is updated only through a reviewed release, which becomes the "who can change the code" control.
- **In transit:** terminate TLS inside the enclave, so the parent proxy forwards encrypted bytes. Otherwise the parent sees plaintext requests, which defeats the purpose.
- **Access control:** unchanged and still essential: caregiver vs viewer roles, the host's confirmation gate, and the double-dose guard. Short-lived session tokens are preferable to static ones, and OAuth for Alexa+ account linking is the production path.
- **Data minimization:** send the model only what a turn needs (Tend's tools already return narrow, person-scoped results), keep notes and pharmacy drafts out of logs, enable Bedrock Guardrails, and keep the offline engine as a no-model option for households that don't want any text leaving the server.

## 5. Can the current architecture benefit?

Partly, and only for the parts Tend controls.
- **Good fit:** the MCP server and data layer are a single Node process with a local SQLite file, no native GPU work, and a small dependency tree. They could run in a Nitro Enclave or a confidential VM with modest changes (TLS termination inside, a vsock proxy, storage via the parent as encrypted blobs).
- **Friction:**
  - `node:sqlite` writes to a local file, and enclaves have no persistent disk. Writes would need to stream to an encrypted file or object store through the parent, or the database would live in enclave memory and checkpoint to encrypted storage.
  - The Bedrock engine needs outbound HTTPS via the parent, and the conversation leaves the TEE at that point.
- **AI provider:** Bedrock can't be inside Tend's TEE boundary. The honest claim is "Tend's record and keys are protected by the TEE; model calls go to Amazon Bedrock under AWS's service commitments". Data minimization and the offline engine are the real levers for model-side privacy.

## 6. Complexity, dependencies, cost and a small proof of concept

- **Complexity:** moderate for a confidential VM (mostly deployment), high for Nitro Enclaves (image build, vsock proxying, in-enclave TLS, KMS policy, attestation verification). A Nitro Enclaves proof of concept is roughly **2–4 focused days** for someone new to Nitro.
- **Dependencies:**
  - Nitro: an enclave-capable EC2 instance, `nitro-cli`, the AWS Nitro Enclaves SDK or a KMS proxy, and an enclave image (EIF) built from a pinned Docker image.
  - SEV-SNP: a supported instance type and the AMD attestation tooling.
- **Cost:** Nitro Enclaves have no separate charge; you pay for the parent EC2 instance (enclaves need a supported instance size, typically 4+ vCPUs), plus KMS requests and storage. Confidential VMs are priced like their instance types. **Any of these is a paid resource and was not created for this assessment.** Check current prices on the AWS pricing pages before approving anything.
- **Smallest proof of concept (Nitro, no app changes at first):**
  1. Build an enclave image containing a tiny "unseal" program that requests its attestation document and calls KMS `Decrypt` through the KMS proxy.
  2. Create a KMS key whose policy allows `Decrypt` only for that image's PCR0.
  3. Show it working, then rebuild with a one-line change: PCR0 changes and KMS refuses. That proves the key-release property.
  4. Only then move Tend's `CareService` and an encrypted SQLite file into the enclave behind a vsock HTTP proxy.

## 7. Demonstrating it to judges without overstating it

- **Before any deployment** (true today), say: "Tend is designed so the care record could be sealed to an attested build. Here is the threat model, and what a TEE would and wouldn't cover." Don't say "Tend uses a TEE" or "your data is protected from AWS".
- **After a real proof of concept**, show evidence rather than adjectives:
  - the attestation document (PCR values) next to the reproducible build hash;
  - the KMS key policy with the PCR condition;
  - a recorded run where a modified image is refused the key.
- **Always state the limits:** model calls leave the enclave, authorized tokens still work, the host can still deny service, and side channels are out of scope.

## 8. The security story to tell for the hackathon

Tend does **not** use a TEE. The credible story is the protections that are implemented and tested today, with the TEE clearly labelled as future work.

| Implemented and tested today | Where |
|---|---|
| Per-caregiver bearer tokens (constant-time compare); the browser only gets 1-hour HMAC-signed session tokens | `src/http/auth.ts`, `test/auth.test.ts` |
| Role-scoped tool registration: viewers never see write tools | `src/mcp/server.ts`, `test/mcp.e2e.test.ts` |
| Server-side double-dose guard, needing explicit confirmation for a second dose | `src/domain/care.ts`, `test/care.test.ts` |
| Two-phase refills with expiry and single-use confirmation; the host blocks self-confirmation by the model | `src/agent/agent.ts`, `test/agent.test.ts` |
| Every record attributed to the caregiver who made it | `src/domain/care.ts` |
| DNS-rebinding protection (Host/Origin checks), body limit, rate limiting, strict CSP, sandboxed MCP App views | `src/http/app.ts`, `test/web.test.ts` |
| Offline engine: with no LLM configured, nothing leaves the machine | `src/agent/offline.ts` |

| Planned, not built | Needs |
|---|---|
| OAuth 2.1 instead of static tokens | Identity provider |
| Encryption at rest for the SQLite file (or DynamoDB with KMS) | AWS account, cost approval |
| Nitro Enclaves key-release proof of concept (section 6) | EC2 + KMS, cost approval |

**Recommended next step:** keep the TEE out of the hackathon build. If there's appetite after submission, and you approve the EC2 and KMS costs, run the 4-step Nitro key-release proof of concept above in a sandbox account, and add this repository's results to this document only once they've been verified.
