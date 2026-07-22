// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Empty } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { useNavigate } from "react-router";

export default function NotFoundRoute() {
	const navigate = useNavigate();

	return (
		<div className="flex items-center justify-center min-h-screen">
			<Empty
				icon={<WarningIcon size={48} className="text-kumo-inactive" />}
				title="404 – Seite nicht gefunden"
				description="Die gesuchte Seite existiert nicht."
				contents={
					<Button variant="primary" size="sm" onClick={() => navigate("/")}>
						Zur Startseite
					</Button>
				}
			/>
		</div>
	);
}
