# Affiliated Organization dropdown

The request form now requires one of the nine Divine Nine organizations, or **Other** with a required custom organization name. Names are alphabetically sorted. The server validates `organizationChoice` and `organization` for both one-time and recurring request endpoints. Existing stored organization names and historical reservations are unchanged.

Deploy the application files in `nphc-scheduling-hub-main` to GitHub main. The new backend validation requires the updated frontend to deploy together. Test one Divine Nine organization, Other, and a direct API call with an invalid organization choice.
